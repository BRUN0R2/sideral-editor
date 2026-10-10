use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;

use crate::error::{AppError, AppResult};

const WORKSPACE_SESSION_FILE_NAME: &str = "workspace-session.json";
const WORKSPACE_SESSION_SCHEMA_VERSION: u8 = 2;
const MAX_WORKSPACE_SESSION_BYTES: u64 = 256 * 1024;
pub const MAX_WORKSPACE_ROOTS: usize = 128;

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct WorkspaceSession {
    roots: Vec<String>,
}

impl WorkspaceSession {
    pub fn from_roots(roots: Vec<String>) -> AppResult<Self> {
        if roots.len() > MAX_WORKSPACE_ROOTS {
            return Err(AppError::InvalidSettings(format!(
                "a workspace session supports at most {MAX_WORKSPACE_ROOTS} roots"
            )));
        }
        let mut seen = HashSet::new();
        for root in &roots {
            if root.is_empty()
                || !Path::new(root).is_absolute()
                || root.chars().any(char::is_control)
            {
                return Err(AppError::InvalidPath(format!(
                    "workspace root {root:?} must be absolute"
                )));
            }
            if !seen.insert(path_key(Path::new(root))) {
                return Err(AppError::InvalidSettings(
                    "workspace session contains duplicate roots".to_owned(),
                ));
            }
        }
        Ok(Self { roots })
    }

    pub fn into_roots(self) -> Vec<String> {
        self.roots
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredWorkspaceSession {
    schema_version: u8,
    roots: Vec<String>,
}

pub fn read(path: &Path) -> AppResult<Option<WorkspaceSession>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(AppError::io(
                format!("could not open {}", path.display()),
                error,
            ));
        }
    };
    let mut source = Vec::new();
    file.take(MAX_WORKSPACE_SESSION_BYTES + 1)
        .read_to_end(&mut source)
        .map_err(|error| AppError::io(format!("could not read {}", path.display()), error))?;
    if source.len() as u64 > MAX_WORKSPACE_SESSION_BYTES {
        return Err(AppError::InvalidSettings(
            "workspace session exceeds the size limit".to_owned(),
        ));
    }
    let stored: StoredWorkspaceSession = serde_json::from_slice(&source).map_err(|error| {
        AppError::InvalidSettings(format!("invalid workspace session JSON structure: {error}"))
    })?;
    if stored.schema_version != WORKSPACE_SESSION_SCHEMA_VERSION {
        return Err(AppError::InvalidSettings(format!(
            "workspace session schema version {} is unsupported",
            stored.schema_version
        )));
    }
    WorkspaceSession::from_roots(stored.roots).map(Some)
}

pub fn write(path: &Path, session: &WorkspaceSession) -> AppResult<()> {
    let stored = StoredWorkspaceSession {
        schema_version: WORKSPACE_SESSION_SCHEMA_VERSION,
        roots: session.roots.clone(),
    };
    let parent = path
        .parent()
        .ok_or_else(|| AppError::InvalidPath("workspace session has no parent".to_owned()))?;
    fs::create_dir_all(parent)
        .map_err(|error| AppError::io(format!("could not create {}", parent.display()), error))?;
    let serialized = serde_json::to_vec_pretty(&stored).map_err(|error| {
        AppError::InvalidSettings(format!("could not serialize workspace session: {error}"))
    })?;
    if serialized.len() as u64 > MAX_WORKSPACE_SESSION_BYTES {
        return Err(AppError::InvalidSettings(
            "workspace session exceeds the size limit".to_owned(),
        ));
    }
    let mut temporary = NamedTempFile::new_in(parent)
        .map_err(|error| AppError::io(format!("could not prepare {}", path.display()), error))?;
    temporary
        .write_all(&serialized)
        .and_then(|()| temporary.write_all(b"\n"))
        .map_err(|error| AppError::io("could not write temporary workspace session", error))?;
    temporary
        .as_file_mut()
        .sync_all()
        .map_err(|error| AppError::io("could not flush workspace session", error))?;
    temporary.persist(path).map_err(|error| {
        AppError::io(
            format!("could not atomically replace {}", path.display()),
            error.error,
        )
    })?;
    Ok(())
}

pub fn file_path(config_directory: &Path) -> PathBuf {
    config_directory.join(WORKSPACE_SESSION_FILE_NAME)
}

pub fn path_key(path: &Path) -> String {
    let path = crate::project_settings::display_path(path);
    if cfg!(windows) {
        path.replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    } else {
        path
    }
}

#[cfg(test)]
mod tests {
    use super::{StoredWorkspaceSession, WorkspaceSession, file_path, read, write};
    use std::fs;
    use tempfile::tempdir;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[test]
    fn persists_multiple_roots_in_order_and_allows_missing_folders() -> TestResult {
        let directory = tempdir()?;
        let roots = ["frontend", "backend"]
            .map(|name| directory.path().join(name).to_string_lossy().into_owned())
            .to_vec();
        let session = WorkspaceSession::from_roots(roots)?;
        let path = file_path(directory.path());
        write(&path, &session)?;
        assert_eq!(read(&path)?, Some(session));
        Ok(())
    }

    #[test]
    fn atomically_replaces_membership_and_supports_an_empty_session() -> TestResult {
        let directory = tempdir()?;
        let path = file_path(directory.path());
        write(
            &path,
            &WorkspaceSession::from_roots(vec![directory.path().to_string_lossy().into_owned()])?,
        )?;
        let empty = WorkspaceSession::from_roots(Vec::new())?;
        write(&path, &empty)?;
        assert_eq!(read(&path)?, Some(empty));
        Ok(())
    }

    #[test]
    fn rejects_relative_and_duplicate_roots() -> TestResult {
        let directory = tempdir()?;
        let root = directory.path().to_string_lossy().into_owned();
        assert!(WorkspaceSession::from_roots(vec!["relative-project".to_owned()]).is_err());
        assert!(WorkspaceSession::from_roots(vec![root.clone(), root]).is_err());
        Ok(())
    }

    #[test]
    fn missing_session_has_no_workspace() -> TestResult {
        let directory = tempdir()?;
        assert_eq!(read(&file_path(directory.path()))?, None);
        Ok(())
    }

    #[test]
    fn rejects_unsupported_session_versions() -> TestResult {
        let directory = tempdir()?;
        let path = file_path(directory.path());
        fs::write(
            &path,
            serde_json::to_vec(&StoredWorkspaceSession {
                schema_version: 255,
                roots: Vec::new(),
            })?,
        )?;
        assert!(read(&path).is_err());
        Ok(())
    }
}
