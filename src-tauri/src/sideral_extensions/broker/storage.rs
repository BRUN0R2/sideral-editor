use std::{collections::BTreeMap, path::PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sideral_extension_core::ExtensionManifest;
use tokio::sync::Mutex as AsyncMutex;

use super::{BrokerShared, CapabilityBroker, atomic_write, read_bounded_file, run_blocking};
use crate::sideral_extensions::error::ExtensionError;

const MAX_KEY_BYTES: usize = 128;
const MAX_STORED_VALUE_BYTES: usize = 256 * 1024;
const STORAGE_DOCUMENT_LIMIT_BYTES: u64 = 2 * 1024 * 1024;
const CONFIGURATION_DOCUMENT_LIMIT_BYTES: u64 = 512 * 1024;
const KEY_VALUE_SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct KeyValueDocument {
    schema_version: u8,
    pub(super) values: BTreeMap<String, Value>,
}

#[derive(Clone, Copy)]
pub(super) enum StoreKind {
    Storage,
    Configuration,
}

impl StoreKind {
    pub(super) const fn file_name(self) -> &'static str {
        match self {
            Self::Storage => "storage.json",
            Self::Configuration => "configuration.json",
        }
    }

    pub(super) const fn limit(self) -> u64 {
        match self {
            Self::Storage => STORAGE_DOCUMENT_LIMIT_BYTES,
            Self::Configuration => CONFIGURATION_DOCUMENT_LIMIT_BYTES,
        }
    }

    pub(super) fn gate(self, shared: &BrokerShared) -> &AsyncMutex<()> {
        match self {
            Self::Storage => &shared.storage_gate,
            Self::Configuration => &shared.configuration_gate,
        }
    }
}

impl CapabilityBroker {
    pub(super) async fn get_stored_value(
        &self,
        manifest: &ExtensionManifest,
        kind: StoreKind,
        key: String,
    ) -> Result<Value, ExtensionError> {
        validate_store_key(&key)?;
        let _gate = kind.gate(&self.shared).lock().await;
        let path = self.store_path(&manifest.id, kind);
        let document = run_blocking(move || read_key_value_document(&path, kind.limit())).await?;
        match document.values.get(&key) {
            Some(value) => Ok(json!({ "found": true, "value": value })),
            None => Ok(json!({ "found": false, "value": null })),
        }
    }

    pub(super) async fn update_stored_value(
        &self,
        manifest: &ExtensionManifest,
        kind: StoreKind,
        key: String,
        value: Option<Value>,
    ) -> Result<Value, ExtensionError> {
        validate_store_key(&key)?;
        if let Some(value) = &value {
            let size = serde_json::to_vec(value)
                .map_err(|error| ExtensionError::InvalidRequest(error.to_string()))?
                .len();
            if size > MAX_STORED_VALUE_BYTES {
                return Err(ExtensionError::InvalidRequest(format!(
                    "stored value exceeds {MAX_STORED_VALUE_BYTES} bytes"
                )));
            }
        }
        let _gate = kind.gate(&self.shared).lock().await;
        let path = self.store_path(&manifest.id, kind);
        run_blocking(move || {
            let mut document = read_key_value_document(&path, kind.limit())?;
            match value {
                Some(value) => {
                    document.values.insert(key, value);
                }
                None => {
                    document.values.remove(&key);
                }
            }
            write_key_value_document(&path, &document, kind.limit())
        })
        .await?;
        Ok(Value::Null)
    }

    pub(super) async fn stored_keys(
        &self,
        manifest: &ExtensionManifest,
        kind: StoreKind,
    ) -> Result<Value, ExtensionError> {
        let _gate = kind.gate(&self.shared).lock().await;
        let path = self.store_path(&manifest.id, kind);
        let document = run_blocking(move || read_key_value_document(&path, kind.limit())).await?;
        serde_json::to_value(document.values.into_keys().collect::<Vec<_>>())
            .map_err(|error| ExtensionError::Runtime(error.to_string()))
    }

    pub(super) fn store_path(&self, extension_id: &str, kind: StoreKind) -> PathBuf {
        self.shared
            .data_root
            .join("data")
            .join(extension_id)
            .join(kind.file_name())
    }
}

pub(super) fn read_key_value_document(
    path: &std::path::Path,
    limit: u64,
) -> Result<KeyValueDocument, ExtensionError> {
    if !path.exists() {
        return Ok(KeyValueDocument {
            schema_version: KEY_VALUE_SCHEMA_VERSION,
            values: BTreeMap::new(),
        });
    }
    let bytes = read_bounded_file(path, limit, "extension data")?;
    let document: KeyValueDocument = serde_json::from_slice(&bytes)
        .map_err(|error| ExtensionError::InvalidRequest(error.to_string()))?;
    if document.schema_version != KEY_VALUE_SCHEMA_VERSION {
        return Err(ExtensionError::InvalidRequest(format!(
            "extension data schema version {} is unsupported",
            document.schema_version
        )));
    }
    Ok(document)
}

pub(super) fn write_key_value_document(
    path: &std::path::Path,
    document: &KeyValueDocument,
    limit: u64,
) -> Result<(), ExtensionError> {
    let mut bytes = serde_json::to_vec_pretty(document)
        .map_err(|error| ExtensionError::Runtime(error.to_string()))?;
    bytes.push(b'\n');
    if bytes.len() as u64 > limit {
        return Err(ExtensionError::InvalidRequest(format!(
            "extension data exceeds {limit} bytes"
        )));
    }
    atomic_write(path, &bytes)
}

pub(super) fn validate_store_key(key: &str) -> Result<(), ExtensionError> {
    if key.is_empty()
        || key.len() > MAX_KEY_BYTES
        || key.starts_with('.')
        || key.ends_with('.')
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(ExtensionError::InvalidRequest(format!(
            "storage key must use 1-{MAX_KEY_BYTES} ASCII letters, digits, dots, underscores or hyphens"
        )));
    }
    Ok(())
}
