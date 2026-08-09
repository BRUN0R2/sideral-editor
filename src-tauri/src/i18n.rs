use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{
    error::{AppError, AppResult},
    settings::{self, Settings},
};

const LOCALE_SCHEMA_VERSION: u8 = 1;
const MAX_LOCALE_FILE_BYTES: u64 = 512 * 1024;
const SYSTEM_LANGUAGE: &str = "system";
const ENGLISH_LOCALE: &str = "en";
const ENGLISH_SOURCE: &str = include_str!("../../locales/en.json");
const PORTUGUESE_BRAZIL_SOURCE: &str = include_str!("../../locales/pt-BR.json");
const LOCALE_SCHEMA_SOURCE: &str = include_str!("../../locales/locale.schema.json");

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub enum TextDirection {
    #[serde(rename = "ltr")]
    LeftToRight,
    #[serde(rename = "rtl")]
    RightToLeft,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocaleFile {
    #[serde(rename = "$schema")]
    _schema: Option<String>,
    schema_version: u8,
    locale: String,
    name: String,
    direction: TextDirection,
    messages: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocaleBundle {
    pub locale: String,
    pub name: String,
    pub direction: TextDirection,
    pub messages: BTreeMap<String, String>,
    pub built_in: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocaleIssue {
    pub file: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocaleCatalog {
    pub locales: Vec<LocaleBundle>,
    pub issues: Vec<LocaleIssue>,
    pub directory: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocaleSelection {
    pub preference: String,
    pub active: LocaleBundle,
    pub catalog: LocaleCatalog,
    pub unavailable_preference: Option<String>,
}

pub fn load_selection(app: &AppHandle, preferred_locales: &[String]) -> AppResult<LocaleSelection> {
    let config_directory = app
        .path()
        .app_config_dir()
        .map_err(|error| AppError::InvalidPath(error.to_string()))?;
    let settings_path = settings::file_path(&config_directory);
    let settings = settings::read(&settings_path)?;
    let catalog = load_catalog(app)?;

    if settings.language.eq_ignore_ascii_case(SYSTEM_LANGUAGE) {
        let active = choose_system_locale(&catalog.locales, preferred_locales)?;
        return Ok(LocaleSelection {
            preference: SYSTEM_LANGUAGE.to_owned(),
            active,
            catalog,
            unavailable_preference: None,
        });
    }

    if let Some(active) = find_exact_locale(&catalog.locales, &settings.language) {
        return Ok(LocaleSelection {
            preference: active.locale.clone(),
            active,
            catalog,
            unavailable_preference: None,
        });
    }

    let active = choose_system_locale(&catalog.locales, preferred_locales)?;
    Ok(LocaleSelection {
        preference: settings.language.clone(),
        active,
        catalog,
        unavailable_preference: Some(settings.language),
    })
}

pub fn set_preference(
    app: &AppHandle,
    preference: String,
    preferred_locales: &[String],
) -> AppResult<LocaleSelection> {
    let catalog = load_catalog(app)?;
    let normalized_preference = normalize_locale_id(&preference);

    let active = if normalized_preference.eq_ignore_ascii_case(SYSTEM_LANGUAGE) {
        choose_system_locale(&catalog.locales, preferred_locales)?
    } else {
        find_exact_locale(&catalog.locales, &normalized_preference).ok_or_else(|| {
            AppError::InvalidLocale(format!("language {normalized_preference} is not installed"))
        })?
    };

    let config_directory = app
        .path()
        .app_config_dir()
        .map_err(|error| AppError::InvalidPath(error.to_string()))?;
    settings::write(
        &settings::file_path(&config_directory),
        &Settings::with_language(normalized_preference.clone()),
    )?;

    Ok(LocaleSelection {
        preference: normalized_preference,
        active,
        catalog,
        unavailable_preference: None,
    })
}

pub fn load_catalog(app: &AppHandle) -> AppResult<LocaleCatalog> {
    let directory = locale_directory(app)?;
    ensure_locale_directory(&directory)?;

    let english = parse_locale(ENGLISH_SOURCE, true, None)?;
    if !english.locale.eq_ignore_ascii_case(ENGLISH_LOCALE) {
        return Err(AppError::InvalidLocale(
            "the primary built-in locale must use the `en` identifier".to_owned(),
        ));
    }
    let required_keys = english.messages.keys().cloned().collect::<BTreeSet<_>>();
    let portuguese = parse_locale(PORTUGUESE_BRAZIL_SOURCE, true, Some(&required_keys))?;

    let mut locales = vec![english, portuguese];
    let mut identifiers = locales
        .iter()
        .map(|locale| locale.locale.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    let mut issues = Vec::new();
    let directory_entries = fs::read_dir(&directory).map_err(|error| {
        AppError::io(
            format!("could not read locale directory {}", directory.display()),
            error,
        )
    })?;
    let mut paths = Vec::new();
    for entry in directory_entries {
        let entry = entry.map_err(|error| {
            AppError::io(
                format!("could not read an entry in {}", directory.display()),
                error,
            )
        })?;
        let path = entry.path();
        if should_load_locale_file(&path) {
            paths.push(path);
        }
    }
    paths.sort();

    for path in paths {
        let file_name = path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());
        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                issues.push(LocaleIssue {
                    file: file_name,
                    reason: format!("could not inspect the file: {error}"),
                });
                continue;
            }
        };
        if metadata.len() > MAX_LOCALE_FILE_BYTES {
            issues.push(LocaleIssue {
                file: file_name,
                reason: "the file exceeds the 512 KiB locale limit".to_owned(),
            });
            continue;
        }
        let source = match fs::read_to_string(&path) {
            Ok(source) => source,
            Err(error) => {
                issues.push(LocaleIssue {
                    file: file_name,
                    reason: format!("could not read the file: {error}"),
                });
                continue;
            }
        };

        match parse_locale(&source, false, Some(&required_keys)) {
            Ok(locale) => {
                let identifier = locale.locale.to_ascii_lowercase();
                if identifiers.insert(identifier) {
                    locales.push(locale);
                } else {
                    issues.push(LocaleIssue {
                        file: file_name,
                        reason: "the locale identifier is already installed".to_owned(),
                    });
                }
            }
            Err(error) => issues.push(LocaleIssue {
                file: file_name,
                reason: error.to_string(),
            }),
        }
    }

    locales.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.locale.cmp(&right.locale))
    });

    Ok(LocaleCatalog {
        locales,
        issues,
        directory: directory.to_string_lossy().into_owned(),
    })
}

pub fn locale_directory(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_config_dir()
        .map(|path| path.join("locales"))
        .map_err(|error| AppError::InvalidPath(error.to_string()))
}

pub fn ensure_locale_directory(directory: &Path) -> AppResult<()> {
    fs::create_dir_all(directory).map_err(|error| {
        AppError::io(
            format!("could not create locale directory {}", directory.display()),
            error,
        )
    })?;
    write_if_missing(&directory.join("locale.schema.json"), LOCALE_SCHEMA_SOURCE)?;
    write_if_missing(&directory.join("locale.example.json"), ENGLISH_SOURCE)?;
    Ok(())
}

fn write_if_missing(path: &Path, source: &str) -> AppResult<()> {
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => file
            .write_all(source.as_bytes())
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_all())
            .map_err(|error| AppError::io(format!("could not create {}", path.display()), error)),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(AppError::io(
            format!("could not create {}", path.display()),
            error,
        )),
    }
}

fn should_load_locale_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    file_name.ends_with(".json")
        && !file_name.ends_with(".schema.json")
        && !file_name.ends_with(".example.json")
}

fn parse_locale(
    source: &str,
    built_in: bool,
    required_keys: Option<&BTreeSet<String>>,
) -> AppResult<LocaleBundle> {
    let locale: LocaleFile = serde_json::from_str(source)
        .map_err(|error| AppError::InvalidLocale(format!("invalid JSON structure: {error}")))?;

    if locale.schema_version != LOCALE_SCHEMA_VERSION {
        return Err(AppError::InvalidLocale(format!(
            "schemaVersion must be {LOCALE_SCHEMA_VERSION}"
        )));
    }
    if !is_valid_locale_id(&locale.locale) {
        return Err(AppError::InvalidLocale(
            "locale must be a BCP 47-style identifier such as `en` or `pt-BR`".to_owned(),
        ));
    }
    if locale.name.trim().is_empty() {
        return Err(AppError::InvalidLocale("name cannot be empty".to_owned()));
    }
    if locale.messages.is_empty() {
        return Err(AppError::InvalidLocale(
            "messages cannot be empty".to_owned(),
        ));
    }
    if let Some((key, _)) = locale
        .messages
        .iter()
        .find(|(key, value)| key.trim().is_empty() || value.trim().is_empty())
    {
        return Err(AppError::InvalidLocale(format!(
            "message `{key}` has an empty key or value"
        )));
    }

    if let Some(required) = required_keys {
        let actual = locale.messages.keys().cloned().collect::<BTreeSet<_>>();
        let missing = required.difference(&actual).cloned().collect::<Vec<_>>();
        let unknown = actual.difference(required).cloned().collect::<Vec<_>>();
        if !missing.is_empty() || !unknown.is_empty() {
            let mut details = Vec::new();
            if !missing.is_empty() {
                details.push(format!("missing keys: {}", missing.join(", ")));
            }
            if !unknown.is_empty() {
                details.push(format!("unknown keys: {}", unknown.join(", ")));
            }
            return Err(AppError::InvalidLocale(details.join("; ")));
        }
    }

    Ok(LocaleBundle {
        locale: normalize_locale_id(&locale.locale),
        name: locale.name.trim().to_owned(),
        direction: locale.direction,
        messages: locale.messages,
        built_in,
    })
}

fn choose_system_locale(
    locales: &[LocaleBundle],
    preferred_locales: &[String],
) -> AppResult<LocaleBundle> {
    for preferred in preferred_locales {
        if let Some(locale) = find_exact_locale(locales, preferred) {
            return Ok(locale);
        }
    }

    for preferred in preferred_locales {
        let language = language_part(preferred);
        if let Some(locale) = locales
            .iter()
            .find(|candidate| language_part(&candidate.locale).eq_ignore_ascii_case(language))
        {
            return Ok(locale.clone());
        }
    }

    find_exact_locale(locales, ENGLISH_LOCALE).ok_or_else(|| {
        AppError::InvalidLocale("the built-in English locale is unavailable".to_owned())
    })
}

fn find_exact_locale(locales: &[LocaleBundle], identifier: &str) -> Option<LocaleBundle> {
    let normalized = normalize_locale_id(identifier);
    locales
        .iter()
        .find(|locale| locale.locale.eq_ignore_ascii_case(&normalized))
        .cloned()
}

fn normalize_locale_id(identifier: &str) -> String {
    identifier.trim().replace('_', "-")
}

fn language_part(identifier: &str) -> &str {
    identifier.split(['-', '_']).next().unwrap_or(identifier)
}

fn is_valid_locale_id(identifier: &str) -> bool {
    let mut parts = identifier.split('-');
    let Some(language) = parts.next() else {
        return false;
    };
    if !(2..=3).contains(&language.len())
        || !language.chars().all(|value| value.is_ascii_alphabetic())
    {
        return false;
    }
    parts.all(|part| {
        (2..=8).contains(&part.len()) && part.chars().all(|value| value.is_ascii_alphanumeric())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_locales_have_the_same_message_contract() -> AppResult<()> {
        let english = parse_locale(ENGLISH_SOURCE, true, None)?;
        let required = english.messages.keys().cloned().collect::<BTreeSet<_>>();
        let portuguese = parse_locale(PORTUGUESE_BRAZIL_SOURCE, true, Some(&required))?;

        assert_eq!(english.messages.len(), portuguese.messages.len());
        Ok(())
    }

    #[test]
    fn rejects_invalid_locale_identifiers() {
        assert!(!is_valid_locale_id("portuguese_br"));
        assert!(!is_valid_locale_id("p"));
        assert!(is_valid_locale_id("pt-BR"));
        assert!(is_valid_locale_id("zh-Hant-TW"));
    }
}
