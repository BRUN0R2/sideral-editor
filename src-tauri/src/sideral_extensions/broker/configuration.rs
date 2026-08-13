use std::path::Path;

use serde_json::Value;
use sideral_extension_core::{ConfigurationProperty, ExtensionManifest};

use super::{
    CapabilityBroker,
    process::resolve_process_executable,
    run_blocking,
    storage::{KeyValueDocument, StoreKind, read_key_value_document, write_key_value_document},
};
use crate::sideral_extensions::{
    error::ExtensionError,
    protocol::{
        ConfigurationUpdate, ExtensionConfigurationPropertyView, ExtensionConfigurationView,
    },
};

impl CapabilityBroker {
    pub(crate) async fn configuration_views(
        &self,
        manifests: Vec<ExtensionManifest>,
    ) -> Result<Vec<ExtensionConfigurationView>, ExtensionError> {
        let sources = manifests
            .into_iter()
            .filter(|manifest| manifest.contributes.configuration.is_some())
            .map(|manifest| {
                let path = self.store_path(&manifest.id, StoreKind::Configuration);
                (manifest, path)
            })
            .collect::<Vec<_>>();
        let _gate = StoreKind::Configuration.gate(&self.shared).lock().await;
        run_blocking(move || {
            sources
                .iter()
                .map(|(manifest, path)| {
                    let document = read_key_value_document(path, StoreKind::Configuration.limit())?;
                    configuration_view(manifest, &document)
                })
                .collect()
        })
        .await
    }

    pub(crate) async fn update_configuration(
        &self,
        manifest: ExtensionManifest,
        key: String,
        update: ConfigurationUpdate,
    ) -> Result<ExtensionConfigurationView, ExtensionError> {
        let property = configuration_property(&manifest, &key)?;
        let stored_value = match update {
            ConfigurationUpdate::Default => None,
            ConfigurationUpdate::Value { value } => {
                property.validate_value(&value).map_err(|_| {
                    ExtensionError::InvalidRequest(format!(
                        "configuration {key} has an invalid executable value"
                    ))
                })?;
                if !Path::new(&value).is_absolute() {
                    return Err(ExtensionError::InvalidRequest(
                        "selected executable paths must be absolute".to_owned(),
                    ));
                }
                let canonical = resolve_process_executable(&value)?;
                let normalized = canonical.into_os_string().into_string().map_err(|_| {
                    ExtensionError::InvalidRequest(
                        "selected executable path is not valid Unicode".to_owned(),
                    )
                })?;
                Some(Value::String(normalized))
            }
        };
        let path = self.store_path(&manifest.id, StoreKind::Configuration);
        let _gate = StoreKind::Configuration.gate(&self.shared).lock().await;
        run_blocking(move || {
            let mut document = read_key_value_document(&path, StoreKind::Configuration.limit())?;
            match stored_value {
                Some(value) => {
                    document.values.insert(key, value);
                }
                None => {
                    document.values.remove(&key);
                }
            }
            write_key_value_document(&path, &document, StoreKind::Configuration.limit())?;
            configuration_view(&manifest, &document)
        })
        .await
    }

    pub(super) async fn configuration_value(
        &self,
        manifest: &ExtensionManifest,
        key: &str,
    ) -> Result<String, ExtensionError> {
        let property = configuration_property(manifest, key)?.clone();
        let path = self.store_path(&manifest.id, StoreKind::Configuration);
        let _gate = StoreKind::Configuration.gate(&self.shared).lock().await;
        let document =
            run_blocking(move || read_key_value_document(&path, StoreKind::Configuration.limit()))
                .await?;
        resolved_value(&property, &document).map(|(value, _)| value)
    }
}

fn configuration_view(
    manifest: &ExtensionManifest,
    document: &KeyValueDocument,
) -> Result<ExtensionConfigurationView, ExtensionError> {
    let contribution = manifest
        .contributes
        .configuration
        .as_ref()
        .ok_or_else(|| ExtensionError::NotFound(format!("{} configuration", manifest.id)))?;
    let properties = contribution
        .properties
        .iter()
        .map(|property| {
            let (value, user_defined) = resolved_value(property, document)?;
            match property {
                ConfigurationProperty::Executable {
                    key,
                    title,
                    description,
                    default,
                } => Ok(ExtensionConfigurationPropertyView::Executable {
                    key: key.clone(),
                    title: title.clone(),
                    description: description.clone(),
                    default_value: default.clone(),
                    value,
                    user_defined,
                }),
            }
        })
        .collect::<Result<Vec<_>, ExtensionError>>()?;
    Ok(ExtensionConfigurationView {
        extension_id: manifest.id.clone(),
        title: contribution.title.clone(),
        properties,
    })
}

fn configuration_property<'a>(
    manifest: &'a ExtensionManifest,
    key: &str,
) -> Result<&'a ConfigurationProperty, ExtensionError> {
    manifest
        .contributes
        .configuration
        .as_ref()
        .and_then(|configuration| {
            configuration
                .properties
                .iter()
                .find(|property| property.key() == key)
        })
        .ok_or_else(|| {
            ExtensionError::InvalidRequest(format!(
                "configuration key {key} was not declared by {}",
                manifest.id
            ))
        })
}

fn resolved_value(
    property: &ConfigurationProperty,
    document: &KeyValueDocument,
) -> Result<(String, bool), ExtensionError> {
    let Some(stored) = document.values.get(property.key()) else {
        return Ok((property.default_value().to_owned(), false));
    };
    let value = stored.as_str().ok_or_else(|| {
        ExtensionError::InvalidRequest(format!(
            "stored configuration {} has an invalid value type",
            property.key()
        ))
    })?;
    property.validate_value(value).map_err(|_| {
        ExtensionError::InvalidRequest(format!(
            "stored configuration {} has an invalid executable value",
            property.key()
        ))
    })?;
    if !Path::new(value).is_absolute() {
        return Err(ExtensionError::InvalidRequest(format!(
            "stored configuration {} must contain an absolute executable path",
            property.key()
        )));
    }
    Ok((value.to_owned(), true))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;
    use sideral_extension_core::parse_manifest_json;
    use tempfile::tempdir;

    use super::{CapabilityBroker, ConfigurationUpdate, ExtensionError, StoreKind};

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[tokio::test]
    async fn resolves_defaults_and_persists_only_valid_selected_executables() -> TestResult {
        let directory = tempdir()?;
        let executable = std::env::current_exe()?;
        let manifest = parse_manifest_json(&manifest_json())?;
        let broker = CapabilityBroker::new(directory.path().join("extensions"))?;

        let initial = broker.configuration_views(vec![manifest.clone()]).await?;
        let initial_property = initial[0].properties.first().ok_or("missing property")?;
        let initial_json = serde_json::to_value(initial_property)?;
        assert_eq!(initial_json["value"], json!("tool"));
        assert_eq!(initial_json["userDefined"], json!(false));

        let selected = broker
            .update_configuration(
                manifest.clone(),
                "tool-path".to_owned(),
                ConfigurationUpdate::Value {
                    value: executable.to_string_lossy().into_owned(),
                },
            )
            .await?;
        let selected_json = serde_json::to_value(&selected.properties[0])?;
        assert_eq!(selected_json["userDefined"], json!(true));
        let stored_path = selected_json["value"].as_str().ok_or("missing path")?;
        assert!(fs::metadata(stored_path)?.is_file());

        let reset = broker
            .update_configuration(
                manifest.clone(),
                "tool-path".to_owned(),
                ConfigurationUpdate::Default,
            )
            .await?;
        let reset_json = serde_json::to_value(&reset.properties[0])?;
        assert_eq!(reset_json["value"], json!("tool"));
        assert_eq!(reset_json["userDefined"], json!(false));

        let configuration_path = broker.store_path(&manifest.id, StoreKind::Configuration);
        fs::write(
            configuration_path,
            r#"{"schemaVersion":1,"values":{"tool-path":"relative-tool"}}"#,
        )?;
        let invalid = broker.configuration_views(vec![manifest]).await;
        assert!(matches!(
            invalid,
            Err(ExtensionError::InvalidRequest(message))
                if message.contains("must contain an absolute executable path")
        ));
        Ok(())
    }

    fn manifest_json() -> String {
        json!({
            "manifestVersion": 1,
            "apiVersion": 1,
            "id": "sample.tool",
            "displayName": "Tool",
            "version": "1.0.0",
            "engines": { "sideral": "^1.0.0" },
            "runtime": { "kind": "worker", "entry": "dist/extension.mjs" },
            "activationEvents": ["onWorkbenchReady"],
            "permissions": {
                "processes": [{
                    "id": "sample.tool.run",
                    "executable": { "kind": "configuration", "key": "tool-path" },
                    "workingDirectory": "executable"
                }]
            },
            "contributes": {
                "configuration": {
                    "title": "Tool",
                    "properties": [{
                        "kind": "executable",
                        "key": "tool-path",
                        "title": "Tool Path",
                        "default": "tool"
                    }]
                }
            }
        })
        .to_string()
    }
}
