use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;

use crate::error::{AppError, AppResult};

const SETTINGS_SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub schema_version: u8,
    pub language: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            language: "system".to_owned(),
        }
    }
}

impl Settings {
    pub fn with_language(language: String) -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            language,
        }
    }
}

pub fn read(path: &Path) -> AppResult<Settings> {
    if !path.exists() {
        return Ok(Settings::default());
    }

    let source = fs::read_to_string(path)
        .map_err(|error| AppError::io(format!("could not read {}", path.display()), error))?;
    let settings: Settings = serde_json::from_str(&source)
        .map_err(|error| AppError::InvalidSettings(format!("invalid JSON structure: {error}")))?;

    if settings.schema_version != SETTINGS_SCHEMA_VERSION {
        return Err(AppError::InvalidSettings(format!(
            "settings schema version {} is unsupported",
            settings.schema_version
        )));
    }

    Ok(settings)
}

pub fn write(path: &Path, settings: &Settings) -> AppResult<()> {
    let parent = path.parent().ok_or_else(|| {
        AppError::InvalidPath(format!("{} has no parent directory", path.display()))
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        AppError::io(
            format!("could not create settings directory {}", parent.display()),
            error,
        )
    })?;

    let serialized = serde_json::to_vec_pretty(settings).map_err(|error| {
        AppError::InvalidSettings(format!("could not serialize settings: {error}"))
    })?;
    let mut temporary = NamedTempFile::new_in(parent).map_err(|error| {
        AppError::io(
            format!(
                "could not create a temporary settings file in {}",
                parent.display()
            ),
            error,
        )
    })?;
    temporary
        .write_all(&serialized)
        .map_err(|error| AppError::io("could not write temporary settings", error))?;
    temporary
        .write_all(b"\n")
        .map_err(|error| AppError::io("could not finish temporary settings", error))?;
    temporary
        .as_file_mut()
        .sync_all()
        .map_err(|error| AppError::io("could not flush temporary settings", error))?;
    temporary.persist(path).map_err(|error| {
        AppError::io(
            format!("could not atomically replace {}", path.display()),
            error.error,
        )
    })?;

    Ok(())
}

pub fn file_path(config_directory: &Path) -> PathBuf {
    config_directory.join("settings.json")
}
