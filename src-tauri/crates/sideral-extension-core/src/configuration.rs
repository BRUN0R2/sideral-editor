use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::ManifestError;

const MAX_CONFIGURATION_PROPERTIES: usize = 64;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ConfigurationProperty {
    Executable {
        key: String,
        title: String,
        #[serde(default)]
        description: Option<String>,
        default: String,
    },
}

impl ConfigurationProperty {
    pub fn key(&self) -> &str {
        match self {
            Self::Executable { key, .. } => key,
        }
    }

    pub fn default_value(&self) -> &str {
        match self {
            Self::Executable { default, .. } => default,
        }
    }

    pub fn validate_value(&self, value: &str) -> Result<(), ManifestError> {
        match self {
            Self::Executable { .. } => validate_executable_value(value),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigurationContribution {
    pub title: String,
    pub properties: Vec<ConfigurationProperty>,
}

impl ConfigurationContribution {
    pub(crate) fn validate(&self) -> Result<HashSet<&str>, ManifestError> {
        validate_text("contributes.configuration.title", &self.title, 120)?;
        if self.properties.is_empty() || self.properties.len() > MAX_CONFIGURATION_PROPERTIES {
            return Err(ManifestError::invalid(
                "contributes.configuration.properties",
                format!("between 1 and {MAX_CONFIGURATION_PROPERTIES} properties are required"),
            ));
        }

        let mut keys = HashSet::new();
        for property in &self.properties {
            match property {
                ConfigurationProperty::Executable {
                    key,
                    title,
                    description,
                    default,
                } => {
                    validate_configuration_key("contributes.configuration.properties.key", key)?;
                    validate_text("contributes.configuration.properties.title", title, 120)?;
                    if let Some(description) = description {
                        validate_text(
                            "contributes.configuration.properties.description",
                            description,
                            500,
                        )?;
                    }
                    validate_default_executable(default)?;
                    if !keys.insert(key.as_str()) {
                        return Err(ManifestError::Duplicate {
                            kind: "configuration property",
                            value: key.clone(),
                        });
                    }
                }
            }
        }
        Ok(keys)
    }
}

pub(crate) fn validate_configuration_key(
    field: &'static str,
    value: &str,
) -> Result<(), ManifestError> {
    if value.is_empty()
        || value.len() > 64
        || value.starts_with('-')
        || value.ends_with('-')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(ManifestError::invalid(
            field,
            "value must use lowercase ASCII letters, digits or inner hyphens",
        ));
    }
    Ok(())
}

fn validate_executable_value(value: &str) -> Result<(), ManifestError> {
    if value.is_empty() || value.trim() != value || value.contains('\0') {
        return Err(ManifestError::invalid(
            "contributes.configuration.properties.default",
            "executable must be non-empty text without surrounding whitespace or NUL bytes",
        ));
    }
    if value.len() > 4_096 {
        return Err(ManifestError::invalid(
            "contributes.configuration.properties.default",
            "executable cannot exceed 4096 bytes",
        ));
    }
    Ok(())
}

fn validate_default_executable(value: &str) -> Result<(), ManifestError> {
    validate_executable_value(value)?;
    if value.contains('/') || value.contains('\\') || value.contains(':') {
        return Err(ManifestError::invalid(
            "contributes.configuration.properties.default",
            "default executable must be a bare name resolved from the operating system PATH",
        ));
    }
    Ok(())
}

fn validate_text(field: &'static str, value: &str, max_length: usize) -> Result<(), ManifestError> {
    if value.is_empty() || value.trim() != value || value.contains('\0') {
        return Err(ManifestError::invalid(
            field,
            "value must be clean, non-empty text without surrounding whitespace",
        ));
    }
    if value.len() > max_length {
        return Err(ManifestError::invalid(
            field,
            format!("value cannot exceed {max_length} bytes"),
        ));
    }
    Ok(())
}
