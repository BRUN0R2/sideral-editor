use std::collections::HashSet;

use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};

use crate::{
    ExtensionSizeBudget, ManifestError, PermissionSet, WorkspaceAccess, budgets::MAX_MANIFEST_BYTES,
    extension_size_budget,
};

const SUPPORTED_MANIFEST_VERSION: u16 = 1;
const SUPPORTED_API_VERSION: u16 = 1;
const MAX_ACTIVATION_EVENTS: usize = 64;
const MAX_COMMANDS: usize = 128;
const MAX_KEYBINDINGS: usize = 128;
const MAX_KEYBINDING_LANGUAGES: usize = 32;

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

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandInvocation {
    #[default]
    Workbench,
    ActiveTextDocument,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandContribution {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub invocation: CommandInvocation,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeybindingContribution {
    pub command: String,
    pub key: String,
    #[serde(default)]
    pub mac: Option<String>,
    #[serde(default)]
    pub languages: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Contributions {
    #[serde(default)]
    pub commands: Vec<CommandContribution>,
    #[serde(default)]
    pub keybindings: Vec<KeybindingContribution>,
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
    pub keybindings: Vec<KeybindingContribution>,
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

        let command_ids = self.validate_commands()?;
        self.validate_keybindings(&command_ids)?;
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
            if command.invocation == CommandInvocation::ActiveTextDocument
                && self.permissions.workspace == WorkspaceAccess::None
            {
                return Err(ManifestError::Inconsistent(format!(
                    "command {} requires workspace read permission for active document context",
                    command.id
                )));
            }
        }
        Ok(command_ids)
    }

    fn validate_keybindings(&self, command_ids: &HashSet<&str>) -> Result<(), ManifestError> {
        if self.contributes.keybindings.len() > MAX_KEYBINDINGS {
            return Err(ManifestError::invalid(
                "contributes.keybindings",
                format!("at most {MAX_KEYBINDINGS} keybindings are allowed"),
            ));
        }

        let mut bound_commands = HashSet::new();
        for keybinding in &self.contributes.keybindings {
            if !command_ids.contains(keybinding.command.as_str()) {
                return Err(ManifestError::invalid(
                    "contributes.keybindings.command",
                    format!("{} is not declared by this extension", keybinding.command),
                ));
            }
            if !bound_commands.insert(keybinding.command.as_str()) {
                return Err(ManifestError::Duplicate {
                    kind: "keybinding command",
                    value: keybinding.command.clone(),
                });
            }
            require_canonical_keybinding("contributes.keybindings.key", &keybinding.key)?;
            if let Some(mac) = &keybinding.mac {
                require_canonical_keybinding("contributes.keybindings.mac", mac)?;
            }
            if keybinding.languages.len() > MAX_KEYBINDING_LANGUAGES {
                return Err(ManifestError::invalid(
                    "contributes.keybindings.languages",
                    format!("at most {MAX_KEYBINDING_LANGUAGES} languages are allowed"),
                ));
            }
            let mut languages = HashSet::new();
            for language in &keybinding.languages {
                validate_token("contributes.keybindings.languages", language, 64)?;
                if !languages.insert(language.as_str()) {
                    return Err(ManifestError::Duplicate {
                        kind: "keybinding language",
                        value: language.clone(),
                    });
                }
            }
        }
        Ok(())
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
            if !self.contributes.keybindings.is_empty() {
                return Err(ManifestError::Inconsistent(
                    "keybinding contributions require a worker runtime".to_owned(),
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
            keybindings: self.contributes.keybindings.clone(),
            permissions: self.permissions.clone(),
            manifest_bytes,
            size_budget: extension_size_budget(),
        }
    }
}

pub fn normalize_keybinding(value: &str) -> Result<String, ManifestError> {
    if value.is_empty() || value.len() > 64 || value.trim() != value {
        return Err(ManifestError::invalid(
            "keybinding",
            "shortcut must be clean text of at most 64 bytes",
        ));
    }

    let mut ctrl = false;
    let mut alt = false;
    let mut shift = false;
    let mut meta = false;
    let mut key = None;
    for part in value.split('+') {
        let normalized = match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => "Ctrl".to_owned(),
            "alt" => "Alt".to_owned(),
            "shift" => "Shift".to_owned(),
            "meta" | "cmd" | "command" => "Meta".to_owned(),
            _ => normalize_key(part)?,
        };
        match normalized.as_str() {
            "Ctrl" if !ctrl => ctrl = true,
            "Alt" if !alt => alt = true,
            "Shift" if !shift => shift = true,
            "Meta" if !meta => meta = true,
            "Ctrl" | "Alt" | "Shift" | "Meta" => {
                return Err(ManifestError::invalid(
                    "keybinding",
                    "shortcut modifiers cannot be repeated",
                ));
            }
            _ if key.is_none() => key = Some(normalized),
            _ => {
                return Err(ManifestError::invalid(
                    "keybinding",
                    "shortcut must contain exactly one non-modifier key",
                ));
            }
        }
    }
    if !ctrl && !alt && !shift && !meta {
        return Err(ManifestError::invalid(
            "keybinding",
            "shortcut must contain at least one modifier",
        ));
    }
    let key = key.ok_or_else(|| {
        ManifestError::invalid("keybinding", "shortcut must contain one non-modifier key")
    })?;
    let mut parts = Vec::with_capacity(5);
    if ctrl {
        parts.push("Ctrl".to_owned());
    }
    if alt {
        parts.push("Alt".to_owned());
    }
    if shift {
        parts.push("Shift".to_owned());
    }
    if meta {
        parts.push("Meta".to_owned());
    }
    parts.push(key);
    let shortcut = parts.join("+");
    if matches!(
        shortcut.as_str(),
        "Ctrl+N"
            | "Ctrl+O"
            | "Ctrl+S"
            | "Ctrl+Shift+O"
            | "Ctrl+Shift+P"
            | "Ctrl+Shift+S"
            | "Ctrl+Shift+X"
            | "Meta+N"
            | "Meta+O"
            | "Meta+S"
            | "Shift+Meta+O"
            | "Shift+Meta+P"
            | "Shift+Meta+S"
            | "Shift+Meta+X"
    ) {
        return Err(ManifestError::invalid(
            "keybinding",
            "shortcut is reserved by the Sideral workbench",
        ));
    }
    Ok(shortcut)
}

fn require_canonical_keybinding(field: &'static str, value: &str) -> Result<(), ManifestError> {
    let normalized = normalize_keybinding(value)?;
    if normalized != value {
        return Err(ManifestError::invalid(
            field,
            format!("shortcut must use canonical form {normalized}"),
        ));
    }
    Ok(())
}

fn normalize_key(value: &str) -> Result<String, ManifestError> {
    if value.len() == 1 && value.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Ok(value.to_ascii_uppercase());
    }
    let lower = value.to_ascii_lowercase();
    let named = match lower.as_str() {
        "arrowdown" => Some("ArrowDown"),
        "arrowleft" => Some("ArrowLeft"),
        "arrowright" => Some("ArrowRight"),
        "arrowup" => Some("ArrowUp"),
        "backspace" => Some("Backspace"),
        "delete" => Some("Delete"),
        "end" => Some("End"),
        "enter" => Some("Enter"),
        "escape" | "esc" => Some("Escape"),
        "home" => Some("Home"),
        "insert" => Some("Insert"),
        "pagedown" => Some("PageDown"),
        "pageup" => Some("PageUp"),
        "space" => Some("Space"),
        "tab" => Some("Tab"),
        _ => None,
    };
    if let Some(named) = named {
        return Ok(named.to_owned());
    }
    if let Some(number) = lower.strip_prefix('f').and_then(|value| value.parse::<u8>().ok())
        && (1..=24).contains(&number)
    {
        return Ok(format!("F{number}"));
    }
    Err(ManifestError::invalid(
        "keybinding",
        "shortcut key must be a letter, digit, function key or supported navigation key",
    ))
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
    use super::{normalize_keybinding, validate_manifest_json};
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

    #[test]
    fn accepts_canonical_language_scoped_keybindings() {
        let source = VALID_MANIFEST.replace(
            "[{ \"id\": \"sample.hello.run\", \"title\": \"Run Hello\" }]",
            "[{ \"id\": \"sample.hello.run\", \"title\": \"Run Hello\", \"invocation\": \"activeTextDocument\" }], \"keybindings\": [{ \"command\": \"sample.hello.run\", \"key\": \"Ctrl+Shift+V\", \"mac\": \"Shift+Meta+V\", \"languages\": [\"markdown\"] }]",
        );

        assert!(matches!(
            validate_manifest_json(&source),
            Ok(inspection) if inspection.keybindings.len() == 1
        ));
    }

    #[test]
    fn rejects_active_document_commands_without_workspace_read_permission() {
        let source = VALID_MANIFEST
            .replace("\"workspace\": \"read\"", "\"workspace\": \"none\"")
            .replace(
                "\"title\": \"Run Hello\"",
                "\"title\": \"Run Hello\", \"invocation\": \"activeTextDocument\"",
            );

        assert!(matches!(
            validate_manifest_json(&source),
            Err(ManifestError::Inconsistent(_))
        ));
    }

    #[test]
    fn normalizes_supported_shortcuts_and_rejects_unmodified_keys() {
        assert_eq!(
            normalize_keybinding("shift+control+v").ok().as_deref(),
            Some("Ctrl+Shift+V")
        );
        assert!(normalize_keybinding("V").is_err());
        assert!(normalize_keybinding("Ctrl+Ctrl+V").is_err());
    }
}
