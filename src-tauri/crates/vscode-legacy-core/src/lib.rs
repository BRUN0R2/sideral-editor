#![forbid(unsafe_code)]

use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

const MAX_MANIFEST_BYTES: usize = 256 * 1024;
const MAX_ACTIVATION_EVENTS: usize = 256;

#[derive(Debug, Error)]
pub enum LegacyManifestError {
    #[error("manifest is {actual_bytes} bytes; the limit is {limit_bytes} bytes")]
    SourceTooLarge {
        actual_bytes: usize,
        limit_bytes: usize,
    },
    #[error("manifest JSON is invalid: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("invalid `{field}`: {reason}")]
    InvalidField {
        field: &'static str,
        reason: String,
    },
    #[error("the manifest has no executable or declarative contribution")]
    EmptyExtension,
}

impl LegacyManifestError {
    fn invalid(field: &'static str, reason: impl Into<String>) -> Self {
        Self::InvalidField {
            field,
            reason: reason.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LegacyCompatibility {
    Declarative,
    Web,
    Node,
    Hybrid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LegacyRuntime {
    BrowserWorker,
    NodeProcess,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyInspection {
    pub id: String,
    pub display_name: String,
    pub version: String,
    pub engine_requirement: String,
    pub compatibility: LegacyCompatibility,
    pub runtimes: Vec<LegacyRuntime>,
    pub has_declarative_contributions: bool,
    pub requires_trusted_process: bool,
    pub activation_event_count: usize,
    pub manifest_bytes: usize,
}

#[derive(Debug, Deserialize)]
struct LegacyEngines {
    vscode: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyManifest {
    name: String,
    publisher: String,
    #[serde(default)]
    display_name: Option<String>,
    version: String,
    engines: LegacyEngines,
    #[serde(default)]
    main: Option<String>,
    #[serde(default)]
    browser: Option<String>,
    #[serde(default)]
    activation_events: Vec<String>,
    #[serde(default)]
    contributes: Option<Value>,
}

pub fn inspect_manifest_json(source: &str) -> Result<LegacyInspection, LegacyManifestError> {
    if source.len() > MAX_MANIFEST_BYTES {
        return Err(LegacyManifestError::SourceTooLarge {
            actual_bytes: source.len(),
            limit_bytes: MAX_MANIFEST_BYTES,
        });
    }

    let manifest: LegacyManifest = serde_json::from_str(source)?;
    manifest.validate()?;
    Ok(manifest.inspect(source.len()))
}

impl LegacyManifest {
    fn validate(&self) -> Result<(), LegacyManifestError> {
        validate_package_token("name", &self.name)?;
        validate_package_token("publisher", &self.publisher)?;
        if let Some(display_name) = &self.display_name {
            validate_text("displayName", display_name, 120)?;
        }
        Version::parse(&self.version)
            .map_err(|error| LegacyManifestError::invalid("version", error.to_string()))?;
        VersionReq::parse(&self.engines.vscode)
            .map_err(|error| LegacyManifestError::invalid("engines.vscode", error.to_string()))?;

        if let Some(main) = &self.main {
            validate_entry("main", main)?;
        }
        if let Some(browser) = &self.browser {
            validate_entry("browser", browser)?;
        }
        if self.activation_events.len() > MAX_ACTIVATION_EVENTS {
            return Err(LegacyManifestError::invalid(
                "activationEvents",
                format!("at most {MAX_ACTIVATION_EVENTS} events are allowed"),
            ));
        }
        if self
            .activation_events
            .iter()
            .any(|event| event.is_empty() || event.contains('\0'))
        {
            return Err(LegacyManifestError::invalid(
                "activationEvents",
                "events must be non-empty text without NUL bytes",
            ));
        }

        let has_contributions = validate_contributions(self.contributes.as_ref())?;
        if self.main.is_none() && self.browser.is_none() && !has_contributions {
            return Err(LegacyManifestError::EmptyExtension);
        }
        Ok(())
    }

    fn inspect(self, manifest_bytes: usize) -> LegacyInspection {
        let has_node_runtime = self.main.is_some();
        let has_browser_runtime = self.browser.is_some();
        let has_declarative_contributions = self
            .contributes
            .as_ref()
            .is_some_and(|value| value.as_object().is_some_and(|map| !map.is_empty()));
        let compatibility = match (has_node_runtime, has_browser_runtime) {
            (false, false) => LegacyCompatibility::Declarative,
            (false, true) => LegacyCompatibility::Web,
            (true, false) => LegacyCompatibility::Node,
            (true, true) => LegacyCompatibility::Hybrid,
        };
        let mut runtimes = Vec::with_capacity(usize::from(has_node_runtime) + usize::from(has_browser_runtime));
        if has_browser_runtime {
            runtimes.push(LegacyRuntime::BrowserWorker);
        }
        if has_node_runtime {
            runtimes.push(LegacyRuntime::NodeProcess);
        }

        LegacyInspection {
            id: format!("{}.{}", self.publisher, self.name),
            display_name: self.display_name.unwrap_or(self.name),
            version: self.version,
            engine_requirement: self.engines.vscode,
            compatibility,
            runtimes,
            has_declarative_contributions,
            requires_trusted_process: has_node_runtime,
            activation_event_count: self.activation_events.len(),
            manifest_bytes,
        }
    }
}

fn validate_contributions(value: Option<&Value>) -> Result<bool, LegacyManifestError> {
    match value {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Object(map)) => Ok(!map.is_empty()),
        Some(_) => Err(LegacyManifestError::invalid(
            "contributes",
            "value must be a JSON object",
        )),
    }
}

fn validate_entry(field: &'static str, value: &str) -> Result<(), LegacyManifestError> {
    let normalized = value.strip_prefix("./").unwrap_or(value);
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.contains('\\')
        || normalized.contains(':')
        || normalized.contains('\0')
        || normalized
            .split('/')
            .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
    {
        return Err(LegacyManifestError::invalid(
            field,
            "entry must be a normalized relative package path",
        ));
    }
    if ![".js", ".cjs", ".mjs"]
        .iter()
        .any(|extension| normalized.ends_with(extension))
    {
        return Err(LegacyManifestError::invalid(
            field,
            "entry must point to a JavaScript module",
        ));
    }
    Ok(())
}

fn validate_package_token(field: &'static str, value: &str) -> Result<(), LegacyManifestError> {
    if value.is_empty()
        || value.len() > 100
        || value.starts_with(['-', '.'])
        || value.ends_with(['-', '.'])
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(LegacyManifestError::invalid(
            field,
            "value must use ASCII letters, digits, hyphens, underscores or inner dots",
        ));
    }
    Ok(())
}

fn validate_text(
    field: &'static str,
    value: &str,
    max_length: usize,
) -> Result<(), LegacyManifestError> {
    if value.is_empty() || value.trim() != value || value.contains('\0') {
        return Err(LegacyManifestError::invalid(
            field,
            "value must be clean, non-empty text without surrounding whitespace",
        ));
    }
    if value.len() > max_length {
        return Err(LegacyManifestError::invalid(
            field,
            format!("value cannot exceed {max_length} bytes"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{LegacyCompatibility, LegacyManifestError, LegacyRuntime, inspect_manifest_json};

    const BASE_MANIFEST: &str = r#"{
        "name": "sample-extension",
        "publisher": "sample",
        "displayName": "Sample Extension",
        "version": "1.2.3",
        "engines": { "vscode": "^1.90.0" },
        "contributes": { "themes": [{ "label": "Sample" }] }
    }"#;

    #[test]
    fn classifies_a_declarative_extension_without_a_runtime() {
        let result = inspect_manifest_json(BASE_MANIFEST);

        assert!(matches!(
            result,
            Ok(inspection)
                if inspection.compatibility == LegacyCompatibility::Declarative
                    && inspection.runtimes.is_empty()
                    && !inspection.requires_trusted_process
        ));
    }

    #[test]
    fn classifies_a_browser_extension_as_web_compatible() {
        let source = BASE_MANIFEST.replace(
            "\"contributes\":",
            "\"browser\": \"./dist/web.js\", \"contributes\":",
        );
        let result = inspect_manifest_json(&source);

        assert!(matches!(
            result,
            Ok(inspection)
                if inspection.compatibility == LegacyCompatibility::Web
                    && inspection.runtimes == [LegacyRuntime::BrowserWorker]
        ));
    }

    #[test]
    fn marks_a_node_extension_as_requiring_a_trusted_process() {
        let source = BASE_MANIFEST.replace(
            "\"contributes\":",
            "\"main\": \"./dist/extension.cjs\", \"contributes\":",
        );
        let result = inspect_manifest_json(&source);

        assert!(matches!(
            result,
            Ok(inspection)
                if inspection.compatibility == LegacyCompatibility::Node
                    && inspection.requires_trusted_process
                    && inspection.runtimes == [LegacyRuntime::NodeProcess]
        ));
    }

    #[test]
    fn classifies_separate_browser_and_node_entries_as_hybrid() {
        let source = BASE_MANIFEST.replace(
            "\"contributes\":",
            "\"main\": \"out/node.js\", \"browser\": \"out/web.js\", \"contributes\":",
        );
        let result = inspect_manifest_json(&source);

        assert!(matches!(
            result,
            Ok(inspection)
                if inspection.compatibility == LegacyCompatibility::Hybrid
                    && inspection.runtimes.len() == 2
        ));
    }

    #[test]
    fn rejects_parent_directory_entries() {
        let source = BASE_MANIFEST.replace(
            "\"contributes\":",
            "\"main\": \"../extension.js\", \"contributes\":",
        );

        assert!(matches!(
            inspect_manifest_json(&source),
            Err(LegacyManifestError::InvalidField { field: "main", .. })
        ));
    }

    #[test]
    fn rejects_an_empty_extension() {
        let source = BASE_MANIFEST.replace(
            "\"contributes\": { \"themes\": [{ \"label\": \"Sample\" }] }",
            "\"contributes\": {}",
        );

        assert!(matches!(
            inspect_manifest_json(&source),
            Err(LegacyManifestError::EmptyExtension)
        ));
    }
}
