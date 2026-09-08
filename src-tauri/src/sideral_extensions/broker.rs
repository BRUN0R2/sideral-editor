use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard, RwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use reqwest::Client;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Map, Value};
use sideral_extension_core::ExtensionManifest;
use tempfile::NamedTempFile;
use tokio::sync::{Mutex as AsyncMutex, Notify, Semaphore};

mod configuration;
mod discord_presence;
mod network;
mod process;
mod storage;
mod window;
mod workspace;

use discord_presence::{DiscordActivityPayload, DiscordPresenceSessions};
#[cfg(test)]
use network::is_public_ipv4;
use network::network_client_builder;
use storage::StoreKind;
#[cfg(test)]
use storage::{read_key_value_document, validate_store_key};
use window::send_message;
#[cfg(test)]
use window::{preview_matches_dismissal, validate_preview_document};
#[cfg(test)]
use workspace::file_uri;
use workspace::require_workspace_permission;

use super::{
    error::ExtensionError,
    protocol::{
        BrokerMethod, BrokerRequest, BrokerResponse, MessageSeverity, PreviewAppearance,
        PreviewFormat, ProtocolFailure,
    },
    service::SideralExtensionState,
};

const BROKER_REQUEST_LIMIT_BYTES: usize = 256 * 1024;
const BROKER_RESPONSE_LIMIT_BYTES: usize = 4 * 1024 * 1024;
const MAX_CONCURRENT_REQUESTS: usize = 64;
const MAX_EARLY_CANCELLATIONS: usize = 128;
const MAX_CONCURRENT_NETWORK_REQUESTS: usize = 16;
const MAX_CONCURRENT_PROCESSES: usize = 4;

#[derive(Clone)]
pub(crate) struct CapabilityBroker {
    shared: Arc<BrokerShared>,
}

struct BrokerShared {
    data_root: PathBuf,
    network_client: Client,
    workspace_root: RwLock<Option<PathBuf>>,
    document_versions: Mutex<HashMap<PathBuf, TrackedDocument>>,
    outputs: Mutex<HashMap<String, OutputResource>>,
    next_output_id: AtomicU64,
    previews: Mutex<HashMap<String, PreviewResource>>,
    next_preview_id: AtomicU64,
    cancellations: Mutex<HashMap<RequestKey, Arc<Cancellation>>>,
    request_slots: Arc<Semaphore>,
    network_slots: Arc<Semaphore>,
    process_slots: Arc<Semaphore>,
    storage_gate: AsyncMutex<()>,
    configuration_gate: AsyncMutex<()>,
    discord_presence: DiscordPresenceSessions,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct RequestKey {
    extension_id: String,
    generation: u64,
    request_id: String,
}

#[derive(Default)]
struct Cancellation {
    started: AtomicBool,
    cancelled: AtomicBool,
    notification: Notify,
}

impl Cancellation {
    fn mark_started(&self) -> bool {
        self.started.swap(true, Ordering::AcqRel)
    }

    fn is_started(&self) -> bool {
        self.started.load(Ordering::Acquire)
    }

    fn cancel(&self) {
        if !self.cancelled.swap(true, Ordering::AcqRel) {
            self.notification.notify_waiters();
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    async fn cancelled(&self) {
        loop {
            if self.is_cancelled() {
                return;
            }
            let notified = self.notification.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

#[derive(Clone)]
struct TrackedDocument {
    content_sha256: String,
    version: u64,
}

#[derive(Clone)]
struct OutputResource {
    extension_id: String,
    name: String,
    content: String,
    reveal_sequence: u32,
}

#[derive(Clone)]
struct PreviewResource {
    extension_id: String,
    title: String,
    format: PreviewFormat,
    content: String,
    source_uri: Option<String>,
    appearance: Option<PreviewAppearance>,
    visible: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyPayload {
    key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateValuePayload {
    key: String,
    value: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExecuteCommandPayload {
    command_id: String,
    #[serde(default)]
    arguments: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadDocumentPayload {
    uri: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteDocumentPayload {
    uri: String,
    content: String,
    expected_version: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FindFilesPayload {
    pattern: String,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NetworkRequestPayload {
    url: String,
    #[serde(default = "default_network_method")]
    method: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    maximum_response_bytes: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProcessPayload {
    grant: String,
    #[serde(default)]
    inputs: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MessagePayload {
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OutputCreatePayload {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OutputResourcePayload {
    resource_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OutputAppendPayload {
    resource_id: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreviewDocumentPayload {
    title: String,
    format: PreviewFormat,
    content: String,
    #[serde(default)]
    source_uri: Option<String>,
    #[serde(default)]
    appearance: Option<PreviewAppearance>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreviewUpdatePayload {
    resource_id: String,
    title: String,
    format: PreviewFormat,
    content: String,
    #[serde(default)]
    source_uri: Option<String>,
    #[serde(default)]
    appearance: Option<PreviewAppearance>,
}

impl CapabilityBroker {
    pub fn new(data_root: PathBuf) -> Result<Self, ExtensionError> {
        let network_client = network_client_builder().build().map_err(|error| {
            ExtensionError::Runtime(format!("could not create extension HTTP client: {error}"))
        })?;
        Ok(Self {
            shared: Arc::new(BrokerShared {
                data_root,
                network_client,
                workspace_root: RwLock::new(None),
                document_versions: Mutex::new(HashMap::new()),
                outputs: Mutex::new(HashMap::new()),
                next_output_id: AtomicU64::new(1),
                previews: Mutex::new(HashMap::new()),
                next_preview_id: AtomicU64::new(1),
                cancellations: Mutex::new(HashMap::new()),
                request_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_REQUESTS)),
                network_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_NETWORK_REQUESTS)),
                process_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_PROCESSES)),
                storage_gate: AsyncMutex::new(()),
                configuration_gate: AsyncMutex::new(()),
                discord_presence: DiscordPresenceSessions::default(),
            }),
        })
    }

    pub async fn execute(
        &self,
        state: &SideralExtensionState,
        manifest: &ExtensionManifest,
        request: BrokerRequest,
    ) -> BrokerResponse {
        let request_id = request.request_id.clone();
        let result = self.execute_checked(state, manifest, request).await;
        match result {
            Ok(result) => BrokerResponse {
                request_id,
                result: Some(result),
                error: None,
            },
            Err(error) => BrokerResponse {
                request_id,
                result: None,
                error: Some(ProtocolFailure {
                    code: error.code().to_owned(),
                    message: error.to_string(),
                }),
            },
        }
    }

    async fn execute_checked(
        &self,
        state: &SideralExtensionState,
        manifest: &ExtensionManifest,
        request: BrokerRequest,
    ) -> Result<Value, ExtensionError> {
        let payload_size = serde_json::to_vec(&request.payload)
            .map_err(|error| ExtensionError::InvalidRequest(error.to_string()))?
            .len();
        if payload_size > BROKER_REQUEST_LIMIT_BYTES {
            return Err(ExtensionError::InvalidRequest(format!(
                "broker payload exceeds {BROKER_REQUEST_LIMIT_BYTES} bytes"
            )));
        }
        let _request_slot = self
            .shared
            .request_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| ExtensionError::Conflict("extension broker is at capacity".to_owned()))?;
        let key = RequestKey {
            extension_id: request.extension_id.clone(),
            generation: request.generation,
            request_id: request.request_id.clone(),
        };
        let cancellation = self.begin_request(key.clone())?;
        if cancellation.is_cancelled() {
            self.finish_request(&key);
            return Err(ExtensionError::Cancelled);
        }
        let result = self
            .dispatch(state, manifest, request, cancellation.clone())
            .await;
        self.finish_request(&key);
        let result = result?;
        let response_size = serde_json::to_vec(&result)
            .map_err(|error| ExtensionError::Runtime(error.to_string()))?
            .len();
        if response_size > BROKER_RESPONSE_LIMIT_BYTES {
            return Err(ExtensionError::Runtime(format!(
                "broker response exceeds {BROKER_RESPONSE_LIMIT_BYTES} bytes"
            )));
        }
        Ok(result)
    }

    async fn dispatch(
        &self,
        state: &SideralExtensionState,
        manifest: &ExtensionManifest,
        request: BrokerRequest,
        cancellation: Arc<Cancellation>,
    ) -> Result<Value, ExtensionError> {
        match request.method {
            BrokerMethod::CommandsExecute => {
                let payload: ExecuteCommandPayload = parse_payload(request.payload)?;
                validate_identifier("command id", &payload.command_id)?;
                state
                    .execute_command(payload.command_id, payload.arguments, None)
                    .await
                    .map(|result| result.unwrap_or(Value::Null))
            }
            BrokerMethod::ConfigurationGet => {
                let payload: KeyPayload = parse_payload(request.payload)?;
                self.configuration_value(manifest, &payload.key)
                    .await
                    .map(Value::String)
            }
            BrokerMethod::DiscordPresenceSetActivity => {
                let payload: DiscordActivityPayload = parse_payload(request.payload)?;
                self.set_discord_activity(manifest, request.generation, payload, cancellation)
                    .await
            }
            BrokerMethod::DiscordPresenceClearActivity => {
                require_empty_payload(&request.payload)?;
                self.clear_discord_activity(manifest, request.generation, cancellation)
                    .await
            }
            BrokerMethod::StorageGet => {
                let payload: KeyPayload = parse_payload(request.payload)?;
                self.get_stored_value(manifest, StoreKind::Storage, payload.key)
                    .await
            }
            BrokerMethod::StorageUpdate => {
                let payload: UpdateValuePayload = parse_payload(request.payload)?;
                self.update_stored_value(
                    manifest,
                    StoreKind::Storage,
                    payload.key,
                    Some(payload.value),
                )
                .await
            }
            BrokerMethod::StorageDelete => {
                let payload: KeyPayload = parse_payload(request.payload)?;
                self.update_stored_value(manifest, StoreKind::Storage, payload.key, None)
                    .await
            }
            BrokerMethod::StorageKeys => {
                require_empty_payload(&request.payload)?;
                self.stored_keys(manifest, StoreKind::Storage).await
            }
            BrokerMethod::WorkspaceReadTextDocument => {
                require_workspace_permission(manifest, false)?;
                let payload: ReadDocumentPayload = parse_payload(request.payload)?;
                self.read_workspace_document(manifest, payload.uri).await
            }
            BrokerMethod::WorkspaceWriteTextDocument => {
                require_workspace_permission(manifest, true)?;
                let payload: WriteDocumentPayload = parse_payload(request.payload)?;
                self.write_workspace_document(manifest, payload).await
            }
            BrokerMethod::WorkspaceFindFiles => {
                require_workspace_permission(manifest, false)?;
                let payload: FindFilesPayload = parse_payload(request.payload)?;
                self.find_workspace_files(payload, cancellation).await
            }
            BrokerMethod::NetworkRequest => {
                let payload: NetworkRequestPayload = parse_payload(request.payload)?;
                self.network_request(manifest, payload, cancellation).await
            }
            BrokerMethod::ProcessesExecute => {
                let payload: ProcessPayload = parse_payload(request.payload)?;
                self.execute_process(manifest, payload.grant, payload.inputs, cancellation)
                    .await
            }
            BrokerMethod::WindowShowInformationMessage => {
                let payload: MessagePayload = parse_payload(request.payload)?;
                send_message(
                    state,
                    manifest,
                    MessageSeverity::Information,
                    payload.message,
                )
            }
            BrokerMethod::WindowShowWarningMessage => {
                let payload: MessagePayload = parse_payload(request.payload)?;
                send_message(state, manifest, MessageSeverity::Warning, payload.message)
            }
            BrokerMethod::WindowShowErrorMessage => {
                let payload: MessagePayload = parse_payload(request.payload)?;
                send_message(state, manifest, MessageSeverity::Error, payload.message)
            }
            BrokerMethod::WindowOutputCreate => {
                let payload: OutputCreatePayload = parse_payload(request.payload)?;
                self.create_output(manifest, payload.name)
            }
            BrokerMethod::WindowOutputAppend => {
                let payload: OutputAppendPayload = parse_payload(request.payload)?;
                self.append_output(manifest, &payload.resource_id, &payload.value)
            }
            BrokerMethod::WindowOutputClear => {
                let payload: OutputResourcePayload = parse_payload(request.payload)?;
                self.clear_output(manifest, &payload.resource_id)
            }
            BrokerMethod::WindowOutputShow => {
                let payload: OutputResourcePayload = parse_payload(request.payload)?;
                self.show_output(state, manifest, &payload.resource_id)
            }
            BrokerMethod::WindowOutputFlush => {
                let payload: OutputResourcePayload = parse_payload(request.payload)?;
                self.flush_output(state, manifest, &payload.resource_id)
            }
            BrokerMethod::WindowOutputDispose => {
                let payload: OutputResourcePayload = parse_payload(request.payload)?;
                self.dispose_output(state, manifest, &payload.resource_id)
            }
            BrokerMethod::WindowPreviewCreate => {
                let payload: PreviewDocumentPayload = parse_payload(request.payload)?;
                self.create_preview(manifest, payload)
            }
            BrokerMethod::WindowPreviewUpdate => {
                let payload: PreviewUpdatePayload = parse_payload(request.payload)?;
                self.update_preview(state, manifest, payload)
            }
            BrokerMethod::WindowPreviewShow => {
                let payload: OutputResourcePayload = parse_payload(request.payload)?;
                self.set_preview_visibility(state, manifest, &payload.resource_id, true)
                    .map(|_| Value::Null)
            }
            BrokerMethod::WindowPreviewHide => {
                let payload: OutputResourcePayload = parse_payload(request.payload)?;
                self.set_preview_visibility(state, manifest, &payload.resource_id, false)
                    .map(|_| Value::Null)
            }
            BrokerMethod::WindowPreviewToggle => {
                let payload: OutputResourcePayload = parse_payload(request.payload)?;
                self.toggle_preview(state, manifest, &payload.resource_id)
                    .map(Value::Bool)
            }
            BrokerMethod::WindowPreviewDispose => {
                let payload: OutputResourcePayload = parse_payload(request.payload)?;
                self.dispose_preview(state, manifest, &payload.resource_id)
            }
        }
    }

    pub fn cancel(&self, extension_id: &str, generation: u64, request_id: &str) {
        let key = RequestKey {
            extension_id: extension_id.to_owned(),
            generation,
            request_id: request_id.to_owned(),
        };
        if let Ok(mut cancellations) = self.shared.cancellations.lock() {
            if let Some(cancellation) = cancellations.get(&key) {
                cancellation.cancel();
                return;
            }
            let early_cancellations = cancellations
                .values()
                .filter(|cancellation| !cancellation.is_started())
                .count();
            if early_cancellations < MAX_EARLY_CANCELLATIONS {
                let cancellation = Arc::new(Cancellation::default());
                cancellation.cancel();
                cancellations.insert(key, cancellation);
            }
        }
    }

    pub fn cancel_extension(&self, extension_id: &str) {
        if let Ok(mut cancellations) = self.shared.cancellations.lock() {
            cancellations.retain(|key, cancellation| {
                if key.extension_id == extension_id {
                    cancellation.cancel();
                    false
                } else {
                    true
                }
            });
        }
        if let Ok(mut outputs) = self.shared.outputs.lock() {
            outputs.retain(|_, output| output.extension_id != extension_id);
        }
        if let Ok(mut previews) = self.shared.previews.lock() {
            previews.retain(|_, preview| preview.extension_id != extension_id);
        }
        self.shared.discord_presence.cancel_extension(extension_id);
    }

    pub fn cancel_all(&self) {
        if let Ok(mut cancellations) = self.shared.cancellations.lock() {
            for cancellation in cancellations.values() {
                cancellation.cancel();
            }
            cancellations.clear();
        }
        if let Ok(mut outputs) = self.shared.outputs.lock() {
            outputs.clear();
        }
        if let Ok(mut previews) = self.shared.previews.lock() {
            previews.clear();
        }
        self.shared.discord_presence.cancel_all();
    }

    pub fn set_workspace_root(&self, root: Option<PathBuf>) -> Result<(), ExtensionError> {
        let canonical = root
            .map(|path| {
                let canonical = fs::canonicalize(&path).map_err(|error| {
                    ExtensionError::io(
                        format!("could not resolve workspace {}", path.display()),
                        error,
                    )
                })?;
                if !canonical.is_dir() {
                    return Err(ExtensionError::InvalidRequest(format!(
                        "workspace {} is not a directory",
                        canonical.display()
                    )));
                }
                Ok(canonical)
            })
            .transpose()?;
        *write_lock(&self.shared.workspace_root, "extension workspace")? = canonical;
        lock(
            &self.shared.document_versions,
            "extension document versions",
        )?
        .clear();
        Ok(())
    }

    fn begin_request(&self, key: RequestKey) -> Result<Arc<Cancellation>, ExtensionError> {
        let mut cancellations = lock(&self.shared.cancellations, "extension cancellations")?;
        if let Some(cancellation) = cancellations.get(&key) {
            if cancellation.mark_started() {
                return Err(ExtensionError::Conflict(
                    "duplicate extension broker request id".to_owned(),
                ));
            }
            return Ok(cancellation.clone());
        }
        let cancellation = Arc::new(Cancellation::default());
        let _ = cancellation.mark_started();
        cancellations.insert(key, cancellation.clone());
        Ok(cancellation)
    }

    fn finish_request(&self, key: &RequestKey) {
        if let Ok(mut cancellations) = self.shared.cancellations.lock() {
            cancellations.remove(key);
        }
    }
}

fn default_network_method() -> String {
    "GET".to_owned()
}

fn parse_payload<T: DeserializeOwned>(payload: Map<String, Value>) -> Result<T, ExtensionError> {
    serde_json::from_value(Value::Object(payload))
        .map_err(|error| ExtensionError::InvalidRequest(error.to_string()))
}

fn require_empty_payload(payload: &Map<String, Value>) -> Result<(), ExtensionError> {
    if payload.is_empty() {
        Ok(())
    } else {
        Err(ExtensionError::InvalidRequest(
            "broker method does not accept a payload".to_owned(),
        ))
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), ExtensionError> {
    let parent = path.parent().ok_or_else(|| {
        ExtensionError::InvalidRequest(format!("{} has no parent", path.display()))
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        ExtensionError::io(format!("could not create {}", parent.display()), error)
    })?;
    let mut temporary = NamedTempFile::new_in(parent).map_err(|error| {
        ExtensionError::io(
            format!("could not create a temporary file in {}", parent.display()),
            error,
        )
    })?;
    if let Ok(metadata) = fs::metadata(path) {
        fs::set_permissions(temporary.path(), metadata.permissions()).map_err(|error| {
            ExtensionError::io(
                format!("could not preserve permissions for {}", path.display()),
                error,
            )
        })?;
    }
    temporary
        .write_all(bytes)
        .and_then(|()| temporary.as_file_mut().sync_all())
        .map_err(|error| ExtensionError::io("could not persist extension data", error))?;
    temporary.persist(path).map_err(|error| {
        ExtensionError::io(
            format!("could not atomically replace {}", path.display()),
            error.error,
        )
    })?;
    Ok(())
}

fn read_bounded_file(
    path: &Path,
    limit: u64,
    description: &str,
) -> Result<Vec<u8>, ExtensionError> {
    let file = fs::File::open(path)
        .map_err(|error| ExtensionError::io(format!("could not open {}", path.display()), error))?;
    let metadata = file.metadata().map_err(|error| {
        ExtensionError::io(format!("could not inspect {}", path.display()), error)
    })?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(ExtensionError::InvalidRequest(format!(
            "{} is not a bounded {description} file",
            path.display()
        )));
    }
    let mut bytes = Vec::with_capacity(
        usize::try_from(metadata.len())
            .unwrap_or(64 * 1024)
            .min(64 * 1024),
    );
    file.take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| ExtensionError::io(format!("could not read {}", path.display()), error))?;
    if bytes.len() as u64 > limit {
        return Err(ExtensionError::InvalidRequest(format!(
            "{description} exceeds {limit} bytes"
        )));
    }
    Ok(bytes)
}

fn validate_identifier(kind: &str, value: &str) -> Result<(), ExtensionError> {
    if value.is_empty()
        || value.len() > 128
        || value.split('.').any(|segment| {
            segment.is_empty()
                || segment.starts_with('-')
                || segment.ends_with('-')
                || !segment
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
    {
        return Err(ExtensionError::InvalidRequest(format!(
            "{kind} is not a valid namespaced identifier"
        )));
    }
    Ok(())
}

async fn run_blocking<T, Operation>(operation: Operation) -> Result<T, ExtensionError>
where
    T: Send + 'static,
    Operation: FnOnce() -> Result<T, ExtensionError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| ExtensionError::Runtime(error.to_string()))?
}

fn lock<'a, T>(
    mutex: &'a Mutex<T>,
    resource: &'static str,
) -> Result<MutexGuard<'a, T>, ExtensionError> {
    mutex
        .lock()
        .map_err(|_| ExtensionError::Runtime(format!("{resource} is unavailable")))
}

fn read_lock<'a, T>(
    lock: &'a RwLock<T>,
    resource: &'static str,
) -> Result<std::sync::RwLockReadGuard<'a, T>, ExtensionError> {
    lock.read()
        .map_err(|_| ExtensionError::Runtime(format!("{resource} is unavailable")))
}

fn write_lock<'a, T>(
    lock: &'a RwLock<T>,
    resource: &'static str,
) -> Result<std::sync::RwLockWriteGuard<'a, T>, ExtensionError> {
    lock.write()
        .map_err(|_| ExtensionError::Runtime(format!("{resource} is unavailable")))
}

#[cfg(test)]
mod tests {
    use std::{error::Error, fs, net::Ipv4Addr};

    use tempfile::tempdir;

    use super::{
        Cancellation, CapabilityBroker, ExtensionError, FindFilesPayload, PreviewResource,
        RequestKey, StoreKind, WriteDocumentPayload, file_uri, is_public_ipv4, lock,
        preview_matches_dismissal, read_key_value_document, validate_preview_document,
        validate_store_key,
    };
    use crate::sideral_extensions::protocol::{
        PreviewAppearance, PreviewFormat, PreviewScrollbarAppearance,
    };

    type TestResult = Result<(), Box<dyn Error>>;

    #[test]
    fn rejects_private_network_destinations() {
        assert!(!is_public_ipv4(Ipv4Addr::new(10, 0, 0, 1)));
        assert!(!is_public_ipv4(Ipv4Addr::new(169, 254, 1, 2)));
        assert!(is_public_ipv4(Ipv4Addr::new(1, 1, 1, 1)));
    }

    #[test]
    fn accepts_only_bounded_portable_storage_keys() {
        assert!(validate_store_key("publisher.feature.value").is_ok());
        for key in ["", ".hidden", "ends.", "contains space", "unsafe/path"] {
            assert!(validate_store_key(key).is_err(), "{key} should be rejected");
        }
    }

    #[test]
    fn rejects_incomplete_persisted_key_value_documents() -> TestResult {
        let directory = tempdir()?;
        let path = directory.path().join("storage.json");

        fs::write(&path, br#"{"values": {}}"#)?;
        assert!(read_key_value_document(&path, 1_024).is_err());

        fs::write(&path, br#"{"schemaVersion": 1}"#)?;
        assert!(read_key_value_document(&path, 1_024).is_err());
        Ok(())
    }

    #[test]
    fn accepts_only_bounded_local_preview_sources() {
        assert!(
            validate_preview_document(
                "README preview",
                "# Safe Markdown",
                Some("file:///D:/workspace/README.md"),
                None,
            )
            .is_ok()
        );
        assert!(
            validate_preview_document(
                "Remote preview",
                "content",
                Some("https://example.com/README.md"),
                None,
            )
            .is_err()
        );
        assert!(validate_preview_document("Invalid", "contains\0nul", None, None).is_err());
        let custom_scrollbar = PreviewScrollbarAppearance {
            track_size: Some(16),
            thumb_size: Some(10),
            track_color: Some("transparent".to_owned()),
            thumb_color: Some("#8b5cf6".to_owned()),
            thumb_hover_color: Some("#a78bfa".to_owned()),
            thumb_active_color: Some("#c4b5fd".to_owned()),
            show_buttons: Some(true),
            button_size: Some(18),
            arrow_size: Some(10),
            arrow_height: Some(5),
            arrow_color: Some("#ddd6fe".to_owned()),
            arrow_hover_color: Some("#ede9fe".to_owned()),
            arrow_active_color: Some("#ffffff".to_owned()),
            corner_radius: Some(12),
        };
        let custom_appearance = PreviewAppearance {
            scrollbar: Some(custom_scrollbar.clone()),
        };
        assert!(
            validate_preview_document("Custom", "content", None, Some(&custom_appearance)).is_ok()
        );
        let narrow_appearance = PreviewAppearance {
            scrollbar: Some(PreviewScrollbarAppearance {
                track_size: Some(8),
                thumb_size: None,
                button_size: Some(8),
                arrow_size: None,
                ..custom_scrollbar.clone()
            }),
        };
        assert!(
            validate_preview_document("Narrow", "content", None, Some(&narrow_appearance)).is_ok()
        );
        let invalid_appearance = PreviewAppearance {
            scrollbar: Some(PreviewScrollbarAppearance {
                thumb_size: Some(17),
                ..custom_scrollbar.clone()
            }),
        };
        assert!(
            validate_preview_document("Invalid", "content", None, Some(&invalid_appearance))
                .is_err()
        );
        let invalid_arrow = PreviewAppearance {
            scrollbar: Some(PreviewScrollbarAppearance {
                track_size: Some(8),
                thumb_size: Some(8),
                button_size: Some(8),
                arrow_size: Some(9),
                ..custom_scrollbar.clone()
            }),
        };
        assert!(
            validate_preview_document("Invalid", "content", None, Some(&invalid_arrow)).is_err()
        );
        let invalid_color = PreviewAppearance {
            scrollbar: Some(PreviewScrollbarAppearance {
                arrow_color: Some("url(unsafe)".to_owned()),
                ..custom_scrollbar
            }),
        };
        assert!(
            validate_preview_document("Invalid", "content", None, Some(&invalid_color)).is_err()
        );
    }

    #[test]
    fn exposes_only_visible_previews_to_workbench_clients() -> TestResult {
        let directory = tempdir()?;
        let broker = CapabilityBroker::new(directory.path().join("extensions"))?;
        let preview = |title: &str, visible: bool| PreviewResource {
            extension_id: "sample.extension".to_owned(),
            title: title.to_owned(),
            format: PreviewFormat::Markdown,
            content: format!("# {title}"),
            source_uri: None,
            appearance: None,
            visible,
        };
        {
            let mut previews = lock(&broker.shared.previews, "test preview resources")?;
            previews.insert("preview:sample:hidden".to_owned(), preview("Hidden", false));
            previews.insert(
                "preview:sample:visible".to_owned(),
                preview("Visible", true),
            );
        }

        let views = broker.visible_preview_views()?;
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].resource_id, "preview:sample:visible");
        assert_eq!(views[0].title, "Visible");
        Ok(())
    }

    #[test]
    fn ignores_a_stale_dismissal_after_a_preview_is_reused() {
        let preview = PreviewResource {
            extension_id: "sample.extension".to_owned(),
            title: "Second document".to_owned(),
            format: PreviewFormat::Markdown,
            content: "# Second document".to_owned(),
            source_uri: Some("file:///D:/workspace/SECOND.md".to_owned()),
            appearance: None,
            visible: true,
        };

        assert!(!preview_matches_dismissal(
            &preview,
            Some("file:///D:/workspace/FIRST.md")
        ));
        assert!(preview_matches_dismissal(
            &preview,
            Some("file:///D:/workspace/SECOND.md")
        ));
    }

    #[test]
    fn workspace_root_is_canonical_and_replaceable() -> TestResult {
        let directory = tempdir()?;
        let nested = directory.path().join("workspace");
        fs::create_dir(&nested)?;
        let broker = CapabilityBroker::new(directory.path().join("extensions"))?;

        broker.set_workspace_root(Some(nested.clone()))?;
        assert_eq!(broker.workspace_root()?, fs::canonicalize(nested)?);
        broker.set_workspace_root(None)?;
        assert!(broker.workspace_root().is_err());
        assert_eq!(StoreKind::Storage.file_name(), "storage.json");
        Ok(())
    }

    #[test]
    fn observes_cancellation_that_arrives_before_a_request() -> TestResult {
        let directory = tempdir()?;
        let broker = CapabilityBroker::new(directory.path().join("extensions"))?;
        let key = RequestKey {
            extension_id: "sample.extension".to_owned(),
            generation: 1,
            request_id: "broker-1-1".to_owned(),
        };

        broker.cancel(&key.extension_id, key.generation, &key.request_id);
        let cancellation = broker.begin_request(key.clone())?;

        assert!(cancellation.is_cancelled());
        broker.finish_request(&key);
        Ok(())
    }

    #[test]
    fn rejects_stale_workspace_writes() -> TestResult {
        let directory = tempdir()?;
        let workspace = directory.path().join("workspace");
        fs::create_dir(&workspace)?;
        let document = workspace.join("sample.txt");
        fs::write(&document, "first")?;
        let broker = CapabilityBroker::new(directory.path().join("extensions"))?;
        broker.set_workspace_root(Some(workspace))?;
        let uri = file_uri(&document)?;

        let first = broker.read_workspace_document_blocking(&uri, &[])?;
        assert_eq!(first["version"], serde_json::json!(1));
        let updated = broker.write_workspace_document_blocking(
            WriteDocumentPayload {
                uri: uri.clone(),
                content: "second".to_owned(),
                expected_version: 1,
            },
            &[],
        )?;
        assert_eq!(updated["version"], serde_json::json!(2));

        let stale = broker.write_workspace_document_blocking(
            WriteDocumentPayload {
                uri,
                content: "stale".to_owned(),
                expected_version: 1,
            },
            &[],
        );
        assert!(matches!(stale, Err(ExtensionError::Conflict(_))));
        Ok(())
    }

    #[test]
    fn returns_a_deterministic_limited_file_search() -> TestResult {
        let directory = tempdir()?;
        let workspace = directory.path().join("workspace");
        fs::create_dir(&workspace)?;
        let first = workspace.join("a.txt");
        fs::write(&first, "a")?;
        fs::write(workspace.join("b.txt"), "b")?;
        let broker = CapabilityBroker::new(directory.path().join("extensions"))?;
        broker.set_workspace_root(Some(workspace))?;

        let matches = broker.find_workspace_files_blocking(
            FindFilesPayload {
                pattern: "*.txt".to_owned(),
                limit: Some(1),
            },
            &Cancellation::default(),
        )?;

        assert_eq!(matches, serde_json::json!([file_uri(&first)?]));
        Ok(())
    }
}
