use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tempfile::NamedTempFile;

use crate::{
    desktop_integration::startup,
    error::{AppError, AppResult, CommandResult},
};

const DESKTOP_PREFERENCES_FILE_NAME: &str = "desktop-preferences.json";
const DESKTOP_PREFERENCES_SCHEMA_VERSION: u8 = 1;
const MAX_DESKTOP_PREFERENCES_BYTES: u64 = 16 * 1024;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AutoSaveMode {
    #[default]
    Off,
    AfterDelay,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopPreferences {
    pub schema_version: u8,
    pub start_with_windows: bool,
    pub start_minimized: bool,
    pub close_to_tray: bool,
    #[serde(default)]
    pub auto_save: AutoSaveMode,
}

impl Default for DesktopPreferences {
    fn default() -> Self {
        Self {
            schema_version: DESKTOP_PREFERENCES_SCHEMA_VERSION,
            start_with_windows: false,
            start_minimized: false,
            close_to_tray: false,
            auto_save: AutoSaveMode::Off,
        }
    }
}

impl DesktopPreferences {
    fn validate(self) -> AppResult<Self> {
        if self.schema_version != DESKTOP_PREFERENCES_SCHEMA_VERSION {
            return Err(AppError::InvalidSettings(format!(
                "desktop preferences schema version {} is unsupported",
                self.schema_version
            )));
        }
        if self.start_minimized && !self.start_with_windows {
            return Err(AppError::InvalidSettings(
                "starting minimized requires Windows startup to be enabled".to_owned(),
            ));
        }
        Ok(self)
    }
}

#[derive(Debug)]
pub struct DesktopPreferencesState {
    preferences: Mutex<DesktopPreferences>,
}

impl DesktopPreferencesState {
    pub fn load(app: &AppHandle) -> AppResult<Self> {
        let path = desktop_preferences_path(app)?;
        let preferences = read(&path)?;
        startup::synchronize(app, preferences.start_with_windows)?;

        Ok(Self {
            preferences: Mutex::new(preferences),
        })
    }

    pub fn current(&self) -> AppResult<DesktopPreferences> {
        self.preferences
            .lock()
            .map(|preferences| *preferences)
            .map_err(|_| AppError::Runtime("desktop preferences are unavailable".to_owned()))
    }

    fn replace(&self, preferences: DesktopPreferences) -> AppResult<()> {
        let mut current = self
            .preferences
            .lock()
            .map_err(|_| AppError::Runtime("desktop preferences are unavailable".to_owned()))?;
        *current = preferences;
        Ok(())
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn save_desktop_preferences(
    app: AppHandle,
    state: State<'_, DesktopPreferencesState>,
    preferences: DesktopPreferences,
) -> CommandResult<DesktopPreferences> {
    let preferences = preferences.validate()?;
    startup::synchronize(&app, preferences.start_with_windows)?;
    write(&desktop_preferences_path(&app)?, &preferences)?;
    state.replace(preferences)?;
    Ok(preferences)
}

fn read(path: &Path) -> AppResult<DesktopPreferences> {
    if !path.exists() {
        return Ok(DesktopPreferences::default());
    }

    let metadata = fs::metadata(path)
        .map_err(|error| AppError::io(format!("could not inspect {}", path.display()), error))?;
    if metadata.len() > MAX_DESKTOP_PREFERENCES_BYTES {
        return Err(AppError::InvalidSettings(
            "desktop preferences exceed the 16 KiB safety limit".to_owned(),
        ));
    }

    let source = fs::read_to_string(path)
        .map_err(|error| AppError::io(format!("could not read {}", path.display()), error))?;
    serde_json::from_str::<DesktopPreferences>(&source)
        .map_err(|error| {
            AppError::InvalidSettings(format!(
                "invalid desktop preferences JSON structure: {error}"
            ))
        })?
        .validate()
}

fn write(path: &Path, preferences: &DesktopPreferences) -> AppResult<()> {
    let parent = path.parent().ok_or_else(|| {
        AppError::InvalidPath(format!("{} has no parent directory", path.display()))
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        AppError::io(
            format!(
                "could not create desktop preferences directory {}",
                parent.display()
            ),
            error,
        )
    })?;

    let serialized = serde_json::to_vec_pretty(preferences).map_err(|error| {
        AppError::InvalidSettings(format!("could not serialize desktop preferences: {error}"))
    })?;
    if serialized.len() as u64 > MAX_DESKTOP_PREFERENCES_BYTES {
        return Err(AppError::InvalidSettings(
            "desktop preferences exceed the 16 KiB safety limit".to_owned(),
        ));
    }

    let mut temporary = NamedTempFile::new_in(parent).map_err(|error| {
        AppError::io(
            format!(
                "could not create a temporary desktop preferences file in {}",
                parent.display()
            ),
            error,
        )
    })?;
    temporary
        .write_all(&serialized)
        .and_then(|()| temporary.write_all(b"\n"))
        .map_err(|error| AppError::io("could not write desktop preferences", error))?;
    temporary
        .as_file_mut()
        .sync_all()
        .map_err(|error| AppError::io("could not flush desktop preferences", error))?;
    temporary.persist(path).map_err(|error| {
        AppError::io(
            format!("could not atomically replace {}", path.display()),
            error.error,
        )
    })?;

    Ok(())
}

fn desktop_preferences_path(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(DESKTOP_PREFERENCES_FILE_NAME))
        .map_err(|error| AppError::InvalidPath(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{AutoSaveMode, DESKTOP_PREFERENCES_SCHEMA_VERSION, DesktopPreferences};

    #[test]
    fn rejects_minimized_start_without_windows_startup() {
        let preferences = DesktopPreferences {
            schema_version: DESKTOP_PREFERENCES_SCHEMA_VERSION,
            start_with_windows: false,
            start_minimized: true,
            close_to_tray: false,
            auto_save: AutoSaveMode::Off,
        };

        assert!(preferences.validate().is_err());
    }

    #[test]
    fn rejects_unknown_desktop_preference_fields() {
        let source = r#"{
            "schemaVersion": 1,
            "startWithWindows": false,
            "startMinimized": false,
            "closeToTray": false,
            "autoSave": "off",
            "legacy": true
        }"#;

        assert!(serde_json::from_str::<DesktopPreferences>(source).is_err());
    }

    #[test]
    fn defaults_auto_save_to_off_when_omitted() {
        let source = r#"{
            "schemaVersion": 1,
            "startWithWindows": false,
            "startMinimized": false,
            "closeToTray": false
        }"#;

        let preferences = serde_json::from_str::<DesktopPreferences>(source);

        assert!(matches!(
            preferences,
            Ok(DesktopPreferences {
                auto_save: AutoSaveMode::Off,
                ..
            })
        ));
    }
}
