use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
};

use serde::Serialize;
use tempfile::NamedTempFile;

use crate::error::{AppError, AppResult};

const MAX_TEXT_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TEXT_FILE_MEGABYTES: u64 = MAX_TEXT_FILE_BYTES / 1024 / 1024;
const MAX_DIRECTORY_ENTRIES: usize = 10_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDocument {
    pub path: String,
    pub name: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedDocument {
    pub path: String,
    pub bytes_written: usize,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DirectoryEntryKind {
    Directory,
    File,
    SymbolicLink,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub path: String,
    pub name: String,
    pub kind: DirectoryEntryKind,
}

pub fn read_text_file(path: PathBuf) -> AppResult<TextDocument> {
    validate_non_empty_path(&path)?;

    let metadata = fs::metadata(&path)
        .map_err(|source| AppError::io(format!("could not inspect {}", path.display()), source))?;

    if !metadata.is_file() {
        return Err(AppError::InvalidPath(format!(
            "{} is not a file",
            path.display()
        )));
    }

    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err(AppError::FileTooLarge {
            limit_megabytes: MAX_TEXT_FILE_MEGABYTES,
        });
    }

    let bytes = fs::read(&path)
        .map_err(|source| AppError::io(format!("could not read {}", path.display()), source))?;

    if bytes.contains(&0) {
        return Err(AppError::BinaryFile);
    }

    let content = String::from_utf8(bytes).map_err(|_| AppError::InvalidUtf8)?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::InvalidPath("the file name is not valid Unicode".to_owned()))?;

    Ok(TextDocument {
        path: display_path(&path),
        name: name.to_owned(),
        content,
    })
}

pub fn create_text_file(directory: PathBuf, name: String) -> AppResult<TextDocument> {
    validate_non_empty_path(&directory)?;
    validate_file_name(&name)?;
    if !directory.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "{} is not an existing directory",
            directory.display()
        )));
    }

    let path = directory.join(&name);
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|source| {
            if source.kind() == std::io::ErrorKind::AlreadyExists {
                AppError::FileAlreadyExists(name.clone())
            } else {
                AppError::io(format!("could not create {}", path.display()), source)
            }
        })?;
    file.sync_all()
        .map_err(|source| AppError::io(format!("could not flush {}", path.display()), source))?;

    Ok(TextDocument {
        path: display_path(&path),
        name,
        content: String::new(),
    })
}

pub fn write_text_file(path: PathBuf, content: String) -> AppResult<SavedDocument> {
    validate_non_empty_path(&path)?;

    let parent = path.parent().ok_or_else(|| {
        AppError::InvalidPath(format!("{} has no parent directory", path.display()))
    })?;

    if !parent.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "{} is not an existing directory",
            parent.display()
        )));
    }

    if path.exists() && !path.is_file() {
        return Err(AppError::InvalidPath(format!(
            "{} is not a writable file",
            path.display()
        )));
    }

    let bytes_written = content.len();
    let mut temporary = NamedTempFile::new_in(parent).map_err(|source| {
        AppError::io(
            format!("could not create a temporary file in {}", parent.display()),
            source,
        )
    })?;

    temporary.write_all(content.as_bytes()).map_err(|source| {
        AppError::io(
            format!("could not write a temporary copy of {}", path.display()),
            source,
        )
    })?;
    temporary.as_file_mut().sync_all().map_err(|source| {
        AppError::io(
            format!("could not flush a temporary copy of {}", path.display()),
            source,
        )
    })?;
    temporary.persist(&path).map_err(|error| {
        AppError::io(
            format!("could not atomically replace {}", path.display()),
            error.error,
        )
    })?;

    Ok(SavedDocument {
        path: display_path(&path),
        bytes_written,
    })
}

pub fn list_directory(path: PathBuf) -> AppResult<Vec<DirectoryEntry>> {
    validate_non_empty_path(&path)?;

    if !path.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "{} is not a directory",
            path.display()
        )));
    }

    let mut entries = Vec::new();
    let directory = fs::read_dir(&path)
        .map_err(|source| AppError::io(format!("could not read {}", path.display()), source))?;

    for entry in directory {
        if entries.len() == MAX_DIRECTORY_ENTRIES {
            return Err(AppError::InvalidPath(format!(
                "{} contains more than {MAX_DIRECTORY_ENTRIES} entries",
                path.display()
            )));
        }

        let entry = entry.map_err(|source| {
            AppError::io(
                format!("could not read an entry in {}", path.display()),
                source,
            )
        })?;
        let file_type = entry.file_type().map_err(|source| {
            AppError::io(
                format!("could not inspect {}", entry.path().display()),
                source,
            )
        })?;
        let kind = if file_type.is_symlink() {
            DirectoryEntryKind::SymbolicLink
        } else if file_type.is_dir() {
            DirectoryEntryKind::Directory
        } else {
            DirectoryEntryKind::File
        };

        entries.push(DirectoryEntry {
            path: display_path(&entry.path()),
            name: entry.file_name().to_string_lossy().into_owned(),
            kind,
        });
    }

    entries.sort_by(|left, right| {
        entry_rank(left.kind)
            .cmp(&entry_rank(right.kind))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });

    Ok(entries)
}

fn validate_non_empty_path(path: &Path) -> AppResult<()> {
    if path.as_os_str().is_empty() {
        return Err(AppError::InvalidPath("the path is empty".to_owned()));
    }
    Ok(())
}

fn validate_file_name(name: &str) -> AppResult<()> {
    const INVALID_CHARACTERS: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

    let mut components = Path::new(name).components();
    let is_single_normal_component =
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    let invalid = name.is_empty()
        || name.trim() != name
        || name.ends_with('.')
        || name.chars().count() > 255
        || name
            .chars()
            .any(|character| character.is_control() || INVALID_CHARACTERS.contains(&character))
        || !is_single_normal_component
        || is_windows_reserved_file_name(name);

    if invalid {
        return Err(AppError::InvalidFileName(name.to_owned()));
    }
    Ok(())
}

fn is_windows_reserved_file_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    let Some(number) = stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"))
    else {
        return false;
    };
    matches!(number, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

const fn entry_rank(kind: DirectoryEntryKind) -> u8 {
    match kind {
        DirectoryEntryKind::Directory => 0,
        DirectoryEntryKind::File => 1,
        DirectoryEntryKind::SymbolicLink => 2,
    }
}

#[cfg(test)]
mod tests {
    use std::{error::Error, fs};

    use tempfile::tempdir;

    use crate::error::AppError;

    use super::{create_text_file, validate_file_name};

    type TestResult = Result<(), Box<dyn Error>>;

    #[test]
    fn creates_an_empty_file_with_the_requested_extension() -> TestResult {
        let directory = tempdir()?;

        let document = create_text_file(directory.path().to_path_buf(), "code.sma".to_owned())?;

        assert_eq!(document.name, "code.sma");
        assert_eq!(document.content, "");
        assert!(directory.path().join("code.sma").is_file());
        Ok(())
    }

    #[test]
    fn never_overwrites_an_existing_entry() -> TestResult {
        let directory = tempdir()?;
        let path = directory.path().join("code.ts");
        fs::write(&path, "preserve me")?;

        let result = create_text_file(directory.path().to_path_buf(), "code.ts".to_owned());

        assert!(matches!(result, Err(AppError::FileAlreadyExists(_))));
        assert_eq!(fs::read_to_string(path)?, "preserve me");
        Ok(())
    }

    #[test]
    fn accepts_regular_extension_and_dotfile_names() -> TestResult {
        for name in ["code.py", "code.ts", "plugin.sma", ".gitignore"] {
            validate_file_name(name)?;
        }
        Ok(())
    }

    #[test]
    fn rejects_paths_reserved_names_and_invalid_characters() {
        for name in [
            "",
            "  ",
            ".",
            "..",
            "../code.ts",
            "nested/code.ts",
            "nested\\code.ts",
            "code?.ts",
            "code.ts ",
            "CON",
            "LPT1.txt",
        ] {
            assert!(
                validate_file_name(name).is_err(),
                "{name} should be invalid"
            );
        }
    }
}
