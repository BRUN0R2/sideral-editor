use std::collections::HashSet;

use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};

use crate::{
    ExtensionSizeBudget, ManifestError, PermissionSet, budgets::MAX_MANIFEST_BYTES,
    extension_size_budget,
};

const SUPPORTED_MANIFEST_VERSION: u16 = 1;
const SUPPORTED_API_VERSION: u16 = 1;
const MAX_ACTIVATION_EVENTS: usize = 64;
const MAX_COMMANDS: usize = 128;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngineRequirements {
    pub sideral: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeKind {
    Worker,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerRuntime {
    pub kind: RuntimeKind,
    pub entry: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandContribution {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub category: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Contributions {
    #[serde(default)]
    pub commands: Vec<CommandContribution>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionManifest {
    pub manifest_version: u16,
    pub api_version: u16,
    pub id: String,
    pub display_name: String,
    pub version: String,
    pub engines: EngineRequirements,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub runtime: Option<WorkerRuntime>,
    #[serde(default)]
    pub activation_events: Vec<String>,
    #[serde(default)]
    pub permissions: PermissionSet,
    #[serde(default)]
    pub contributes: Contributions,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionInspection {
    pub manifest_version: u16,
    pub api_version: u16,
    pub id: String,
    pub display_name: String,
    pub version: String,
    pub engine_requirement: String,
    pub runtime: Option<RuntimeKind>,
    pub entry: Option<String>,
    pub activation_events: Vec<String>,
    pub commands: Vec<CommandContribution>,
    pub permissions: PermissionSet,
    pub manifest_bytes: usize,
    pub size_budget: ExtensionSizeBudget,
}

pub fn validate_manifest_json(source: &str) -> Result<ExtensionInspection, ManifestError> {
    let manifest = parse_manifest_json(source)?;
    Ok(manifest.inspect(source.len()))
}

pub fn parse_manifest_json(source: &str) -> Result<ExtensionManifest, ManifestError> {
    if source.len() > MAX_MANIFEST_BYTES {
        return Err(ManifestError::SourceTooLarge {
            actual_bytes: source.len(),
            limit_bytes: MAX_MANIFEST_BYTES,
        });
    }

    let manifest: ExtensionManifest = serde_json::from_str(source)?;
    manifest.validate()?;
    Ok(manifest)
}

impl ExtensionManifest {
    pub fn validate(&self) -> Result<(), ManifestError> {
        if self.manifest_version != SUPPORTED_MANIFEST_VERSION {
            return Err(ManifestError::UnsupportedManifestVersion(
                self.manifest_version,
            ));
        }
        if self.api_version != SUPPORTED_API_VERSION {
            return Err(ManifestError::invalid(
                "apiVersion",
                format!("API version {} is not supported", self.api_version),
            ));
        }

        validate_identifier("id", &self.id, true)?;
        validate_text("displayName", &self.display_name, 120)?;
        validate_optional_text("description", self.description.as_deref(), 2_000)?;
        validate_optional_text("license", self.license.as_deref(), 100)?;
        Version::parse(&self.version)
            .map_err(|error| ManifestError::invalid("version", error.to_string()))?;
        VersionReq::parse(&self.engines.sideral)
            .map_err(|error| ManifestError::invalid("engines.sideral", error.to_string()))?;

        if let Some(runtime) = &self.runtime {
            validate_worker_entry(&runtime.entry)?;
        }

        self.validate_commands()?;
        self.validate_activation_events()?;
        self.permissions.validate(&self.id)?;
        self.validate_runtime_consistency()?;
        Ok(())
    }

    fn validate_commands(&self) -> Result<HashSet<&str>, ManifestError> {
        if self.contributes.commands.len() > MAX_COMMANDS {
            return Err(ManifestError::invalid(
                "contributes.commands",
                format!("at most {MAX_COMMANDS} commands are allowed"),
            ));
        }

        let expected_prefix = format!("{}.", self.id);
        let mut command_ids = HashSet::new();
        for command in &self.contributes.commands {
            validate_identifier("contributes.commands.id", &command.id, true)?;
            validate_text("contributes.commands.title", &command.title, 120)?;
            validate_optional_text(
                "contributes.commands.category",
                command.category.as_deref(),
                80,
            )?;
            if !command.id.starts_with(&expected_prefix) {
                return Err(ManifestError::invalid(
                    "contributes.commands.id",
                    format!("{} must start with {expected_prefix}", command.id),
                ));
            }
            if !command_ids.insert(command.id.as_str()) {
                return Err(ManifestError::Duplicate {
                    kind: "command",
                    value: command.id.clone(),
                });
            }
        }
        Ok(command_ids)
    }

    fn validate_activation_events(&self) -> Result<(), ManifestError> {
        if self.activation_events.len() > MAX_ACTIVATION_EVENTS {
            return Err(ManifestError::invalid(
                "activationEvents",
                format!("at most {MAX_ACTIVATION_EVENTS} events are allowed"),
            ));
        }

        let mut unique_events = HashSet::new();
        for event in &self.activation_events {
            if !unique_events.insert(event.as_str()) {
                return Err(ManifestError::Duplicate {
                    kind: "activation event",
                    value: event.clone(),
                });
            }

            if event == "onWorkbenchReady" {
                continue;
            }
            if let Some(language_id) = event.strip_prefix("onLanguage:") {
                validate_token("activationEvents", language_id, 64)?;
                continue;
            }

            return Err(ManifestError::invalid(
                "activationEvents",
                format!("unsupported event {event}"),
            ));
        }
        Ok(())
    }

    fn validate_runtime_consistency(&self) -> Result<(), ManifestError> {
        if self.runtime.is_none() {
            if !self.activation_events.is_empty() {
                return Err(ManifestError::Inconsistent(
                    "activation events require a worker runtime".to_owned(),
                ));
            }
            if !self.permissions.is_empty() {
                return Err(ManifestError::Inconsistent(
                    "permissions require a worker runtime".to_owned(),
                ));
            }
            if !self.contributes.commands.is_empty() {
                return Err(ManifestError::Inconsistent(
                    "command contributions require a worker runtime".to_owned(),
                ));
            }
            return Err(ManifestError::Inconsistent(
                "the manifest does not contribute any supported feature".to_owned(),
            ));
        }

        if self.activation_events.is_empty() && self.contributes.commands.is_empty() {
            return Err(ManifestError::Inconsistent(
                "a worker requires at least one activation event or command contribution"
                    .to_owned(),
            ));
        }
        Ok(())
    }

    pub fn inspect(&self, manifest_bytes: usize) -> ExtensionInspection {
        let runtime = self.runtime.as_ref().map(|value| value.kind);
        let entry = self.runtime.as_ref().map(|value| value.entry.clone());
        ExtensionInspection {
            manifest_version: self.manifest_version,
            api_version: self.api_version,
            id: self.id.clone(),
            display_name: self.display_name.clone(),
            version: self.version.clone(),
            engine_requirement: self.engines.sideral.clone(),
            runtime,
            entry,
            activation_events: self.activation_events.clone(),
            commands: self.contributes.commands.clone(),
            permissions: self.permissions.clone(),
            manifest_bytes,
            size_budget: extension_size_budget(),
        }
    }
}

fn validate_worker_entry(entry: &str) -> Result<(), ManifestError> {
    validate_package_path("runtime.entry", entry)?;
    if !entry.ends_with(".js") && !entry.ends_with(".mjs") {
        return Err(ManifestError::invalid(
            "runtime.entry",
            "worker entry must be a bundled .js or .mjs file",
        ));
    }
    Ok(())
}

pub fn validate_package_path(field: &'static str, value: &str) -> Result<(), ManifestError> {
    if value.is_empty()
        || !value.is_ascii()
        || value.starts_with('/')
        || value.contains('\\')
        || value.contains(':')
        || value.contains('\0')
        || value
            .split('/')
            .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
    {
        return Err(ManifestError::invalid(
            field,
            "path must be normalized ASCII, relative and use forward slashes",
        ));
    }
    Ok(())
}

fn validate_identifier(
    field: &'static str,
    value: &str,
    require_namespace: bool,
) -> Result<(), ManifestError> {
    if value.len() > 128 || (require_namespace && !value.contains('.')) {
        return Err(ManifestError::invalid(
            field,
            "identifier must be namespaced and cannot exceed 128 bytes",
        ));
    }
    if value.split('.').any(|segment| {
        segment.is_empty()
            || segment.starts_with('-')
            || segment.ends_with('-')
            || !segment
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    }) {
        return Err(ManifestError::invalid(
            field,
            "identifier segments must use lowercase ASCII letters, digits or inner hyphens",
        ));
    }
    Ok(())
}

fn validate_token(
    field: &'static str,
    value: &str,
    max_length: usize,
) -> Result<(), ManifestError> {
    if value.is_empty()
        || value.len() > max_length
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'+' | b'.'))
    {
        return Err(ManifestError::invalid(field, "event target is invalid"));
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

fn validate_optional_text(
    field: &'static str,
    value: Option<&str>,
    max_length: usize,
) -> Result<(), ManifestError> {
    if let Some(value) = value {
        validate_text(field, value, max_length)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_manifest_json;
    use crate::{ManifestError, RuntimeKind, WorkspaceAccess};

    const VALID_MANIFEST: &str = r#"{
        "manifestVersion": 1,
        "apiVersion": 1,
        "id": "sample.hello",
        "displayName": "Hello",
        "version": "1.0.0",
        "engines": { "sideral": "^1.0.0" },
        "runtime": { "kind": "worker", "entry": "dist/extension.js" },
        "permissions": {
            "workspace": "read",
            "network": [{ "origin": "https://api.example.com", "methods": ["GET"] }]
        },
        "contributes": {
            "commands": [{ "id": "sample.hello.run", "title": "Run Hello" }]
        }
    }"#;

    #[test]
    fn accepts_a_small_worker_manifest() {
        let result = validate_manifest_json(VALID_MANIFEST);

        assert!(matches!(
            result,
            Ok(inspection)
                if inspection.runtime == Some(RuntimeKind::Worker)
                    && inspection.permissions.workspace == WorkspaceAccess::Read
                    && inspection.commands[0].id == "sample.hello.run"
        ));
    }

    #[test]
    fn rejects_unknown_manifest_fields() {
        let source = VALID_MANIFEST.replace(
            "\"manifestVersion\": 1,",
            "\"manifestVersion\": 1, \"unknownRuntime\": true,",
        );

        assert!(matches!(
            validate_manifest_json(&source),
            Err(ManifestError::InvalidJson(_))
        ));
    }

    #[test]
    fn rejects_non_worker_runtime_kinds() {
        let source = VALID_MANIFEST.replace("\"kind\": \"worker\"", "\"kind\": \"node\"");

        assert!(matches!(
            validate_manifest_json(&source),
            Err(ManifestError::InvalidJson(_))
        ));
    }

    #[test]
    fn rejects_parent_directory_entries() {
        let source = VALID_MANIFEST.replace("dist/extension.js", "../extension.js");

        assert!(matches!(
            validate_manifest_json(&source),
            Err(ManifestError::InvalidField {
                field: "runtime.entry",
                ..
            })
        ));
    }

    #[test]
    fn rejects_external_plain_http_permissions() {
        let source = VALID_MANIFEST.replace("https://api.example.com", "http://api.example.com");

        assert!(matches!(
            validate_manifest_json(&source),
            Err(ManifestError::InvalidField {
                field: "permissions.network",
                ..
            })
        ));
    }

    #[test]
    fn rejects_redundant_command_activation() {
        let source = VALID_MANIFEST.replace(
            "\"permissions\":",
            "\"activationEvents\": [\"onCommand:sample.hello.run\"], \"permissions\":",
        );

        assert!(matches!(
            validate_manifest_json(&source),
            Err(ManifestError::InvalidField {
                field: "activationEvents",
                ..
            })
        ));
    }

    #[test]
    fn rejects_permissions_without_a_runtime() {
        let source = VALID_MANIFEST.replace(
            "\"runtime\": { \"kind\": \"worker\", \"entry\": \"dist/extension.js\" },",
            "",
        );

        assert!(matches!(
            validate_manifest_json(&source),
            Err(ManifestError::Inconsistent(_))
        ));
    }

    #[test]
    fn rejects_duplicate_commands() {
        let source = VALID_MANIFEST.replace(
            "[{ \"id\": \"sample.hello.run\", \"title\": \"Run Hello\" }]",
            "[{ \"id\": \"sample.hello.run\", \"title\": \"Run Hello\" }, { \"id\": \"sample.hello.run\", \"title\": \"Run Again\" }]",
        );

        assert!(matches!(
            validate_manifest_json(&source),
            Err(ManifestError::Duplicate {
                kind: "command",
                ..
            })
        ));
    }

    #[test]
    fn rejects_duplicate_process_grant_ids() {
        let source = VALID_MANIFEST.replace(
            "\"network\": [{ \"origin\": \"https://api.example.com\", \"methods\": [\"GET\"] }]",
            "\"network\": [{ \"origin\": \"https://api.example.com\", \"methods\": [\"GET\"] }], \"processes\": [{ \"id\": \"sample.hello.tool\", \"executable\": \"tool\", \"arguments\": [\"one\"] }, { \"id\": \"sample.hello.tool\", \"executable\": \"tool\", \"arguments\": [\"two\"] }]",
        );

        assert!(matches!(
            validate_manifest_json(&source),
            Err(ManifestError::Duplicate {
                kind: "process permission id",
                ..
            })
        ));
    }
}
