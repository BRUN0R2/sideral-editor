use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Deserializer, Serialize, de::DeserializeOwned};
use tempfile::NamedTempFile;

use crate::{
    desktop_integration::preferences::AutoSaveMode,
    error::{AppError, AppResult},
};

pub const CONFIG_DIRECTORY_NAME: &str = ".sideral";
pub const WORKSPACE_FILE_NAME: &str = "workspace.json";
pub const SETTINGS_FILE_NAME: &str = "settings.json";
pub const WORKSPACE_SCHEMA_URI: &str = "sideral://schemas/workspace";
pub const SETTINGS_SCHEMA_URI: &str = "sideral://schemas/project-settings";
const PROJECT_SCHEMA_VERSION: u8 = 1;
const MAX_PROJECT_CONFIG_BYTES: u64 = 64 * 1024;
const MAX_WORKSPACE_NAME_CHARACTERS: usize = 128;
const MIN_TAB_SIZE: u8 = 1;
const MAX_TAB_SIZE: u8 = 8;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectEditorSettings {
    #[serde(
        default,
        deserialize_with = "optional_setting",
        skip_serializing_if = "Option::is_none"
    )]
    pub tab_size: Option<u8>,
    #[serde(
        default,
        deserialize_with = "optional_setting",
        skip_serializing_if = "Option::is_none"
    )]
    pub insert_spaces: Option<bool>,
    #[serde(
        default,
        deserialize_with = "optional_setting",
        skip_serializing_if = "Option::is_none"
    )]
    pub word_wrap: Option<WordWrap>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WordWrap {
    Off,
    On,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectFileSettings {
    #[serde(
        default,
        deserialize_with = "optional_setting",
        skip_serializing_if = "Option::is_none"
    )]
    pub auto_save: Option<AutoSaveMode>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSettings {
    #[serde(
        rename = "$schema",
        default,
        deserialize_with = "optional_setting",
        skip_serializing_if = "Option::is_none"
    )]
    pub schema: Option<String>,
    pub schema_version: u8,
    #[serde(
        default,
        deserialize_with = "optional_setting",
        skip_serializing_if = "Option::is_none"
    )]
    pub editor: Option<ProjectEditorSettings>,
    #[serde(
        default,
        deserialize_with = "optional_setting",
        skip_serializing_if = "Option::is_none"
    )]
    pub files: Option<ProjectFileSettings>,
}

impl Default for ProjectSettings {
    fn default() -> Self {
        Self {
            schema: Some(SETTINGS_SCHEMA_URI.to_owned()),
            schema_version: PROJECT_SCHEMA_VERSION,
            editor: Some(ProjectEditorSettings::default()),
            files: Some(ProjectFileSettings::default()),
        }
    }
}

impl ProjectSettings {
    pub fn validate(&self) -> AppResult<()> {
        validate_version(self.schema_version)?;
        validate_schema(self.schema.as_deref(), SETTINGS_SCHEMA_URI)?;
        if self
            .editor
            .as_ref()
            .and_then(|editor| editor.tab_size)
            .is_some_and(|size| !(MIN_TAB_SIZE..=MAX_TAB_SIZE).contains(&size))
        {
            return Err(AppError::InvalidSettings(format!(
                "editor.tabSize must be between {MIN_TAB_SIZE} and {MAX_TAB_SIZE}"
            )));
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceDescriptor {
    #[serde(
        rename = "$schema",
        default,
        deserialize_with = "optional_setting",
        skip_serializing_if = "Option::is_none"
    )]
    pub schema: Option<String>,
    pub schema_version: u8,
    pub name: String,
}

impl WorkspaceDescriptor {
    fn validate(&self) -> AppResult<()> {
        validate_version(self.schema_version)?;
        validate_schema(self.schema.as_deref(), WORKSPACE_SCHEMA_URI)?;
        if self.name.trim().is_empty()
            || self.name.trim() != self.name
            || self.name.chars().count() > MAX_WORKSPACE_NAME_CHARACTERS
            || self.name.chars().any(char::is_control)
        {
            return Err(AppError::InvalidSettings(
                "workspace name must be a nonempty, trimmed name of at most 128 characters"
                    .to_owned(),
            ));
        }
        Ok(())
    }
}

pub fn read_descriptor(root: &Path) -> AppResult<Option<WorkspaceDescriptor>> {
    let value = read_config::<WorkspaceDescriptor>(root, WORKSPACE_FILE_NAME)?;
    if let Some(descriptor) = &value {
        descriptor.validate()?;
    }
    Ok(value)
}

pub fn read_settings(root: &Path) -> AppResult<ProjectSettings> {
    let settings = read_config::<ProjectSettings>(root, SETTINGS_FILE_NAME)?.unwrap_or_default();
    settings.validate()?;
    Ok(settings)
}

pub fn initialize(root: &Path, name: String) -> AppResult<PathBuf> {
    let descriptor = WorkspaceDescriptor {
        schema: Some(WORKSPACE_SCHEMA_URI.to_owned()),
        schema_version: PROJECT_SCHEMA_VERSION,
        name,
    };
    descriptor.validate()?;
    let directory = root.join(CONFIG_DIRECTORY_NAME);
    fs::create_dir_all(&directory).map_err(|error| {
        AppError::io(format!("could not create {}", directory.display()), error)
    })?;
    validate_config_directory(root, &directory)?;
    // Settings are prepared first; the identification file is the final publication.
    write_missing_config(
        &directory.join(SETTINGS_FILE_NAME),
        &ProjectSettings::default(),
    )?;
    write_missing_config(&directory.join(WORKSPACE_FILE_NAME), &descriptor)?;
    Ok(directory.join(SETTINGS_FILE_NAME))
}

pub fn schema(uri: &str) -> AppResult<Option<serde_json::Value>> {
    let source = match uri {
        SETTINGS_SCHEMA_URI => include_str!("../../schemas/project-settings.schema.json"),
        WORKSPACE_SCHEMA_URI => include_str!("../../schemas/workspace.schema.json"),
        _ => return Ok(None),
    };
    serde_json::from_str(source)
        .map(Some)
        .map_err(|error| AppError::JsonSchema(format!("invalid built-in project schema: {error}")))
}

pub fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(&value).to_owned()
    }
}

fn read_config<Value: DeserializeOwned>(root: &Path, name: &str) -> AppResult<Option<Value>> {
    let directory = root.join(CONFIG_DIRECTORY_NAME);
    if !directory.try_exists().map_err(|error| {
        AppError::io(format!("could not inspect {}", directory.display()), error)
    })? {
        return Ok(None);
    }
    validate_config_directory(root, &directory)?;
    let path = directory.join(name);
    let canonical = match fs::canonicalize(&path) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(AppError::io(
                format!("could not open {}", path.display()),
                error,
            ));
        }
    };
    let canonical_root = fs::canonicalize(root)
        .map_err(|error| AppError::io("could not resolve workspace configuration root", error))?;
    if !canonical.starts_with(&canonical_root) || !canonical.is_file() {
        return Err(AppError::InvalidPath(format!(
            "{} is outside its workspace",
            path.display()
        )));
    }
    let file = File::open(&canonical)
        .map_err(|error| AppError::io(format!("could not open {}", path.display()), error))?;
    let mut source = Vec::new();
    file.take(MAX_PROJECT_CONFIG_BYTES + 1)
        .read_to_end(&mut source)
        .map_err(|error| AppError::io(format!("could not read {}", path.display()), error))?;
    if source.len() as u64 > MAX_PROJECT_CONFIG_BYTES {
        return Err(AppError::InvalidSettings(format!(
            "{} exceeds the project configuration size limit",
            path.display()
        )));
    }
    serde_json::from_slice(&source)
        .map(Some)
        .map_err(|error| AppError::InvalidSettings(format!("{}: {error}", path.display())))
}

fn validate_config_directory(root: &Path, directory: &Path) -> AppResult<()> {
    let canonical_root = fs::canonicalize(root)
        .map_err(|error| AppError::io("could not resolve workspace configuration root", error))?;
    let canonical = fs::canonicalize(directory).map_err(|error| {
        AppError::io(format!("could not resolve {}", directory.display()), error)
    })?;
    if !canonical.starts_with(&canonical_root) || !canonical.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "{} must be a directory inside its workspace",
            directory.display()
        )));
    }
    Ok(())
}

fn write_missing_config<Value: Serialize>(path: &Path, value: &Value) -> AppResult<()> {
    if path
        .try_exists()
        .map_err(|error| AppError::io(format!("could not inspect {}", path.display()), error))?
    {
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or_else(|| AppError::InvalidPath("configuration has no parent".to_owned()))?;
    let mut temporary = NamedTempFile::new_in(parent)
        .map_err(|error| AppError::io(format!("could not prepare {}", path.display()), error))?;
    serde_json::to_writer_pretty(&mut temporary, value).map_err(|error| {
        AppError::InvalidSettings(format!("could not serialize {}: {error}", path.display()))
    })?;
    temporary
        .write_all(b"\n")
        .map_err(|error| AppError::io(format!("could not finish {}", path.display()), error))?;
    temporary
        .as_file_mut()
        .sync_all()
        .map_err(|error| AppError::io(format!("could not flush {}", path.display()), error))?;
    temporary.persist_noclobber(path).map_err(|error| {
        AppError::io(format!("could not create {}", path.display()), error.error)
    })?;
    Ok(())
}

fn validate_version(version: u8) -> AppResult<()> {
    if version != PROJECT_SCHEMA_VERSION {
        return Err(AppError::InvalidSettings(format!(
            "project configuration schema version {version} is unsupported"
        )));
    }
    Ok(())
}

fn validate_schema(uri: Option<&str>, expected: &str) -> AppResult<()> {
    if uri.is_some_and(|uri| uri != expected) {
        return Err(AppError::InvalidSettings(format!(
            "configuration schema must be {expected}"
        )));
    }
    Ok(())
}

fn optional_setting<'de, D: Deserializer<'de>, Value: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[test]
    fn opening_an_unconfigured_root_inherits_without_creating_files() -> TestResult {
        let root = tempdir()?;
        assert!(read_descriptor(root.path())?.is_none());
        assert_eq!(
            read_settings(root.path())?.schema_version,
            PROJECT_SCHEMA_VERSION
        );
        assert!(!root.path().join(CONFIG_DIRECTORY_NAME).exists());
        Ok(())
    }

    #[test]
    fn initializes_an_identifiable_workspace_and_preserves_existing_preferences() -> TestResult {
        let root = tempdir()?;
        let path = initialize(root.path(), "API".to_owned())?;
        fs::write(
            &path,
            r#"{"schemaVersion":1,"editor":{"tabSize":2,"insertSpaces":false},"files":{"autoSave":"off"}}"#,
        )?;
        let before = fs::read(&path)?;
        initialize(root.path(), "Replacement name".to_owned())?;
        assert_eq!(fs::read(&path)?, before);
        assert_eq!(
            read_descriptor(root.path())?.ok_or("missing marker")?.name,
            "API"
        );
        let settings = read_settings(root.path())?;
        assert_eq!(
            settings.editor.as_ref().and_then(|editor| editor.tab_size),
            Some(2)
        );
        assert_eq!(
            settings
                .editor
                .as_ref()
                .and_then(|editor| editor.insert_spaces),
            Some(false)
        );
        Ok(())
    }

    #[test]
    fn rejects_unknown_null_out_of_range_and_future_settings() -> TestResult {
        let root = tempdir()?;
        let path = initialize(root.path(), "API".to_owned())?;
        for source in [
            r#"{"schemaVersion":2}"#,
            r#"{"schemaVersion":1,"editor":{"tabSize":0}}"#,
            r#"{"schemaVersion":1,"editor":{"tabSize":9}}"#,
            r#"{"schemaVersion":1,"editor":{"unknown":true}}"#,
            r#"{"schemaVersion":1,"editor":null}"#,
            r#"{"schemaVersion":1,"editor":{"wordWrap":null}}"#,
            r#"{"schemaVersion":1,"files":{"autoSave":"sometimes"}}"#,
            r#"{"schemaVersion":1,"$schema":"https://unrelated.test/settings"}"#,
        ] {
            fs::write(&path, source)?;
            assert!(
                read_settings(root.path()).is_err(),
                "accepted invalid settings: {source}"
            );
        }
        fs::write(&path, vec![b' '; (MAX_PROJECT_CONFIG_BYTES + 1) as usize])?;
        assert!(read_settings(root.path()).is_err());
        Ok(())
    }

    #[test]
    fn validates_marker_names_before_publishing_configuration() -> TestResult {
        let root = tempdir()?;
        for name in ["", " leading", "trailing ", "control\nname"] {
            assert!(initialize(root.path(), name.to_owned()).is_err());
        }
        assert!(initialize(root.path(), "x".repeat(MAX_WORKSPACE_NAME_CHARACTERS + 1)).is_err());
        assert!(!root.path().join(CONFIG_DIRECTORY_NAME).exists());
        assert!(schema(WORKSPACE_SCHEMA_URI)?.is_some());
        assert!(schema(SETTINGS_SCHEMA_URI)?.is_some());
        assert!(schema("sideral://unknown")?.is_none());
        Ok(())
    }
}
