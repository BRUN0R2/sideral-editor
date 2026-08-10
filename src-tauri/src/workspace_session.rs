use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;

use crate::error::{AppError, AppResult};

const WORKSPACE_SESSION_FILE_NAME: &str = "workspace-session.json";
const WORKSPACE_SESSION_SCHEMA_VERSION: u8 = 1;
const MAX_WORKSPACE_SESSION_BYTES: u64 = 16 * 1024;

#[derive(Debug, Eq, PartialEq)]
pub struct WorkspaceSession {
    root: String,
}

impl WorkspaceSession {
    pub fn from_root(root: String) -> AppResult<Self> {
        Ok(Self {
            root: validate_root(root)?,
        })
    }

    pub fn root(&self) -> &str {
        &self.root
    }

    pub fn into_root(self) -> String {
        self.root
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredWorkspaceSession {
    schema_version: u8,
    root: String,
}

pub fn read(path: &Path) -> AppResult<Option<WorkspaceSession>> {
    if !path.exists() {
        return Ok(None);
    }

    let metadata = fs::metadata(path)
        .map_err(|error| AppError::io(format!("could not inspect {}", path.display()), error))?;
    if metadata.len() > MAX_WORKSPACE_SESSION_BYTES {
        return Err(AppError::InvalidSettings(
            "workspace session exceeds the 16 KiB safety limit".to_owned(),
        ));
    }

    let source = fs::read_to_string(path)
        .map_err(|error| AppError::io(format!("could not read {}", path.display()), error))?;
    let stored: StoredWorkspaceSession = serde_json::from_str(&source).map_err(|error| {
        AppError::InvalidSettings(format!("invalid workspace session JSON structure: {error}"))
    })?;
    if stored.schema_version != WORKSPACE_SESSION_SCHEMA_VERSION {
        return Err(AppError::InvalidSettings(format!(
            "workspace session schema version {} is unsupported",
            stored.schema_version
        )));
    }

    WorkspaceSession::from_root(stored.root).map(Some)
}

pub fn write(path: &Path, session: &WorkspaceSession) -> AppResult<()> {
    let stored = StoredWorkspaceSession {
        schema_version: WORKSPACE_SESSION_SCHEMA_VERSION,
        root: session.root.clone(),
    };
    let parent = path.parent().ok_or_else(|| {
        AppError::InvalidPath(format!("{} has no parent directory", path.display()))
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        AppError::io(
            format!(
                "could not create workspace session directory {}",
                parent.display()
            ),
            error,
        )
    })?;

    let serialized = serde_json::to_vec_pretty(&stored).map_err(|error| {
        AppError::InvalidSettings(format!("could not serialize workspace session: {error}"))
    })?;
    if serialized.len() as u64 > MAX_WORKSPACE_SESSION_BYTES {
        return Err(AppError::InvalidSettings(
            "workspace session exceeds the 16 KiB safety limit".to_owned(),
        ));
    }

    let mut temporary = NamedTempFile::new_in(parent).map_err(|error| {
        AppError::io(
            format!(
                "could not create a temporary workspace session file in {}",
                parent.display()
            ),
            error,
        )
    })?;
    temporary
        .write_all(&serialized)
        .map_err(|error| AppError::io("could not write temporary workspace session", error))?;
    temporary
        .write_all(b"\n")
        .map_err(|error| AppError::io("could not finish temporary workspace session", error))?;
    temporary
        .as_file_mut()
        .sync_all()
        .map_err(|error| AppError::io("could not flush temporary workspace session", error))?;
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

fn validate_root(root: String) -> AppResult<String> {
    let path = Path::new(&root);
    if path.as_os_str().is_empty() {
        return Err(AppError::InvalidPath(
            "the workspace root is empty".to_owned(),
        ));
    }
    if !path.is_absolute() {
        return Err(AppError::InvalidPath(format!(
            "workspace root {} is not absolute",
            path.display()
        )));
    }
    let metadata = fs::metadata(path).map_err(|error| {
        AppError::io(
            format!("could not inspect workspace root {}", path.display()),
            error,
        )
    })?;
    if !metadata.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "workspace root {} is not a directory",
            path.display()
        )));
    }

    Ok(root)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::{StoredWorkspaceSession, WorkspaceSession, file_path, read, write};

    #[test]
    fn missing_session_has_no_workspace() -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempdir()?;

        assert_eq!(read(&file_path(directory.path()))?, None);
        Ok(())
    }

    #[test]
    fn persists_one_valid_workspace_root() -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempdir()?;
        let root = directory.path().join("project");
        fs::create_dir(&root)?;
        let path = file_path(directory.path());

        let session = WorkspaceSession::from_root(root.to_string_lossy().into_owned())?;
        write(&path, &session)?;

        assert_eq!(read(&path)?, Some(session));
        Ok(())
    }

    #[test]
    fn replaces_the_previous_workspace_root() -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempdir()?;
        let first_root = directory.path().join("first-project");
        let second_root = directory.path().join("second-project");
        fs::create_dir(&first_root)?;
        fs::create_dir(&second_root)?;
        let path = file_path(directory.path());

        let first_session = WorkspaceSession::from_root(first_root.to_string_lossy().into_owned())?;
        let second_session =
            WorkspaceSession::from_root(second_root.to_string_lossy().into_owned())?;
        write(&path, &first_session)?;
        write(&path, &second_session)?;

        assert_eq!(read(&path)?, Some(second_session));
        Ok(())
    }

    #[test]
    fn rejects_relative_workspace_roots() -> Result<(), Box<dyn std::error::Error>> {
        let Err(error) = WorkspaceSession::from_root("relative-project".to_owned()) else {
            return Err("relative roots must be rejected".into());
        };

        assert!(error.to_string().contains("is not absolute"));
        Ok(())
    }

    #[test]
    fn rejects_unsupported_session_versions() -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempdir()?;
        let path = file_path(directory.path());
        let stored = StoredWorkspaceSession {
            schema_version: 2,
            root: directory.path().to_string_lossy().into_owned(),
        };
        fs::write(&path, serde_json::to_vec(&stored)?)?;

        let Err(error) = read(&path) else {
            return Err("unsupported versions must be rejected".into());
        };

        assert!(error.to_string().contains("version 2 is unsupported"));
        Ok(())
    }
}
