use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    fs,
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs},
    path::{Path, PathBuf},
    process::Stdio,
    str::FromStr,
    sync::{
        Arc, Mutex, MutexGuard, RwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use globset::GlobBuilder;
use reqwest::{
    Client, Method,
    header::{AUTHORIZATION, CONTENT_LENGTH, HeaderMap, HeaderName, HeaderValue, LOCATION},
    redirect::Policy,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use sideral_extension_core::{ExtensionManifest, NetworkMethod, WorkspaceAccess};
use tempfile::NamedTempFile;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::{Mutex as AsyncMutex, Notify, Semaphore},
};
use url::{Host, Url};

use super::{
    error::ExtensionError,
    protocol::{
        BrokerMethod, BrokerRequest, BrokerResponse, ExtensionClientInstruction, MessageSeverity,
        OutputChannelView, ProtocolFailure,
    },
    service::SideralExtensionState,
};

const BROKER_REQUEST_LIMIT_BYTES: usize = 256 * 1024;
const BROKER_RESPONSE_LIMIT_BYTES: usize = 4 * 1024 * 1024;
const MAX_CONCURRENT_REQUESTS: usize = 64;
const MAX_EARLY_CANCELLATIONS: usize = 128;
const MAX_CONCURRENT_NETWORK_REQUESTS: usize = 16;
const MAX_CONCURRENT_PROCESSES: usize = 4;
const MAX_NETWORK_REQUEST_BODY_BYTES: usize = 1024 * 1024;
const DEFAULT_NETWORK_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_NETWORK_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const NETWORK_DEADLINE: Duration = Duration::from_secs(30);
const MAX_NETWORK_REDIRECTS: usize = 5;
const MAX_NETWORK_HEADERS: usize = 64;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_NETWORK_RESPONSE_HEADERS: usize = 128;
const MAX_RESPONSE_HEADER_BYTES: usize = 64 * 1024;
const MAX_TEXT_DOCUMENT_BYTES: u64 = 4 * 1024 * 1024;
const DEFAULT_FIND_LIMIT: usize = 100;
const MAX_FIND_LIMIT: usize = 1_000;
const MAX_TRAVERSED_ENTRIES: usize = 100_000;
const PROCESS_DEADLINE: Duration = Duration::from_secs(30);
const MAX_PROCESS_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_MESSAGE_BYTES: usize = 4 * 1024;
const MAX_OUTPUT_CHANNELS_PER_EXTENSION: usize = 32;
const MAX_OUTPUT_CHANNEL_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_APPEND_BYTES: usize = 64 * 1024;
const MAX_KEY_BYTES: usize = 128;
const MAX_STORED_VALUE_BYTES: usize = 256 * 1024;
const STORAGE_DOCUMENT_LIMIT_BYTES: u64 = 2 * 1024 * 1024;
const CONFIGURATION_DOCUMENT_LIMIT_BYTES: u64 = 512 * 1024;
const KEY_VALUE_SCHEMA_VERSION: u8 = 1;

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
    cancellations: Mutex<HashMap<RequestKey, Arc<Cancellation>>>,
    request_slots: Arc<Semaphore>,
    network_slots: Arc<Semaphore>,
    process_slots: Arc<Semaphore>,
    storage_gate: AsyncMutex<()>,
    configuration_gate: AsyncMutex<()>,
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
    visible: bool,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyValueDocument {
    #[serde(default = "key_value_schema_version")]
    schema_version: u8,
    #[serde(default)]
    values: BTreeMap<String, Value>,
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
                cancellations: Mutex::new(HashMap::new()),
                request_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_REQUESTS)),
                network_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_NETWORK_REQUESTS)),
                process_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_PROCESSES)),
                storage_gate: AsyncMutex::new(()),
                configuration_gate: AsyncMutex::new(()),
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
                    .execute_command(payload.command_id, payload.arguments)
                    .await
                    .map(|result| result.unwrap_or(Value::Null))
            }
            BrokerMethod::ConfigurationGet => {
                let payload: KeyPayload = parse_payload(request.payload)?;
                self.get_stored_value(manifest, StoreKind::Configuration, payload.key)
                    .await
            }
            BrokerMethod::ConfigurationUpdate => {
                let payload: UpdateValuePayload = parse_payload(request.payload)?;
                self.update_stored_value(
                    manifest,
                    StoreKind::Configuration,
                    payload.key,
                    Some(payload.value),
                )
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
                self.read_workspace_document(payload.uri).await
            }
            BrokerMethod::WorkspaceWriteTextDocument => {
                require_workspace_permission(manifest, true)?;
                let payload: WriteDocumentPayload = parse_payload(request.payload)?;
                self.write_workspace_document(payload).await
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
                self.execute_process(manifest, payload.grant, cancellation)
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
    }

    pub fn output_views(&self) -> Result<Vec<OutputChannelView>, ExtensionError> {
        let outputs = lock(&self.shared.outputs, "extension output channels")?;
        let mut views = outputs
            .iter()
            .map(|(resource_id, output)| output_view(resource_id, output))
            .collect::<Vec<_>>();
        views.sort_by(|left, right| left.resource_id.cmp(&right.resource_id));
        Ok(views)
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

    async fn get_stored_value(
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

    async fn update_stored_value(
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

    async fn stored_keys(
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

    fn store_path(&self, extension_id: &str, kind: StoreKind) -> PathBuf {
        self.shared
            .data_root
            .join("data")
            .join(extension_id)
            .join(kind.file_name())
    }

    async fn read_workspace_document(&self, uri: String) -> Result<Value, ExtensionError> {
        let broker = self.clone();
        run_blocking(move || broker.read_workspace_document_blocking(&uri)).await
    }

    fn read_workspace_document_blocking(&self, uri: &str) -> Result<Value, ExtensionError> {
        let path = self.canonical_workspace_file(uri)?;
        let mut versions = lock(
            &self.shared.document_versions,
            "extension document versions",
        )?;
        let bytes = read_bounded_file(&path, MAX_TEXT_DOCUMENT_BYTES, "workspace document")?;
        if bytes.contains(&0) {
            return Err(ExtensionError::InvalidRequest(
                "workspace document is binary".to_owned(),
            ));
        }
        let content = String::from_utf8(bytes)
            .map_err(|_| ExtensionError::InvalidRequest("document is not UTF-8".to_owned()))?;
        let content_sha256 = sha256_hex(content.as_bytes());
        let version = track_document_version(&mut versions, &path, &content_sha256);
        Ok(json!({
            "uri": file_uri(&path)?,
            "languageId": language_id(&path),
            "version": version,
            "content": content,
        }))
    }

    async fn write_workspace_document(
        &self,
        payload: WriteDocumentPayload,
    ) -> Result<Value, ExtensionError> {
        if payload.content.len() as u64 > MAX_TEXT_DOCUMENT_BYTES {
            return Err(ExtensionError::InvalidRequest(format!(
                "document exceeds {MAX_TEXT_DOCUMENT_BYTES} bytes"
            )));
        }
        if payload.content.contains('\0') {
            return Err(ExtensionError::InvalidRequest(
                "workspace document content cannot contain NUL bytes".to_owned(),
            ));
        }
        let broker = self.clone();
        run_blocking(move || broker.write_workspace_document_blocking(payload)).await
    }

    fn write_workspace_document_blocking(
        &self,
        payload: WriteDocumentPayload,
    ) -> Result<Value, ExtensionError> {
        let path = self.canonical_workspace_file(&payload.uri)?;
        let mut versions = lock(
            &self.shared.document_versions,
            "extension document versions",
        )?;
        let existing = read_bounded_file(&path, MAX_TEXT_DOCUMENT_BYTES, "workspace document")?;
        if existing.contains(&0) || std::str::from_utf8(&existing).is_err() {
            return Err(ExtensionError::InvalidRequest(
                "workspace document is not UTF-8 text".to_owned(),
            ));
        }
        let existing_sha256 = sha256_hex(&existing);
        let current_version = track_document_version(&mut versions, &path, &existing_sha256);
        if current_version != payload.expected_version {
            return Err(ExtensionError::Conflict(format!(
                "document version changed: expected {}, current {current_version}",
                payload.expected_version
            )));
        }
        atomic_write(&path, payload.content.as_bytes())?;
        let content_sha256 = sha256_hex(payload.content.as_bytes());
        let version = current_version.saturating_add(1);
        versions.insert(
            path.clone(),
            TrackedDocument {
                content_sha256,
                version,
            },
        );
        Ok(json!({
            "uri": file_uri(&path)?,
            "languageId": language_id(&path),
            "version": version,
            "content": payload.content,
        }))
    }

    async fn find_workspace_files(
        &self,
        payload: FindFilesPayload,
        cancellation: Arc<Cancellation>,
    ) -> Result<Value, ExtensionError> {
        let broker = self.clone();
        run_blocking(move || broker.find_workspace_files_blocking(payload, &cancellation)).await
    }

    fn find_workspace_files_blocking(
        &self,
        payload: FindFilesPayload,
        cancellation: &Cancellation,
    ) -> Result<Value, ExtensionError> {
        if payload.pattern.is_empty()
            || payload.pattern.len() > 256
            || payload.pattern.contains('\\')
        {
            return Err(ExtensionError::InvalidRequest(
                "file pattern must be a non-empty, forward-slash glob of at most 256 bytes"
                    .to_owned(),
            ));
        }
        let limit = payload.limit.unwrap_or(DEFAULT_FIND_LIMIT);
        if !(1..=MAX_FIND_LIMIT).contains(&limit) {
            return Err(ExtensionError::InvalidRequest(format!(
                "find limit must be between 1 and {MAX_FIND_LIMIT}"
            )));
        }
        let matcher = GlobBuilder::new(&payload.pattern)
            .literal_separator(true)
            .build()
            .map_err(|error| ExtensionError::InvalidRequest(format!("invalid glob: {error}")))?
            .compile_matcher();
        let root = self.workspace_root()?;
        let mut queue = VecDeque::from([root.clone()]);
        let mut matches = Vec::new();
        let mut traversed = 0_usize;
        while let Some(directory) = queue.pop_front() {
            if cancellation.is_cancelled() {
                return Err(ExtensionError::Cancelled);
            }
            let entries = fs::read_dir(&directory).map_err(|error| {
                ExtensionError::io(format!("could not read {}", directory.display()), error)
            })?;
            let mut entries = entries.collect::<Result<Vec<_>, _>>().map_err(|error| {
                ExtensionError::io(
                    format!("could not read an entry in {}", directory.display()),
                    error,
                )
            })?;
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                if cancellation.is_cancelled() {
                    return Err(ExtensionError::Cancelled);
                }
                traversed = traversed.saturating_add(1);
                if traversed > MAX_TRAVERSED_ENTRIES {
                    return Err(ExtensionError::InvalidRequest(format!(
                        "workspace search exceeded {MAX_TRAVERSED_ENTRIES} entries"
                    )));
                }
                let file_type = entry.file_type().map_err(|error| {
                    ExtensionError::io(
                        format!("could not inspect {}", entry.path().display()),
                        error,
                    )
                })?;
                if file_type.is_symlink() {
                    continue;
                }
                if file_type.is_dir() {
                    queue.push_back(entry.path());
                    continue;
                }
                if !file_type.is_file() {
                    continue;
                }
                let path = entry.path();
                let relative = path.strip_prefix(&root).map_err(|_| {
                    ExtensionError::Runtime("workspace traversal escaped its root".to_owned())
                })?;
                let candidate = relative.to_string_lossy().replace('\\', "/");
                if matcher.is_match(&candidate) {
                    matches.push(file_uri(&path)?);
                    if matches.len() == limit {
                        matches.sort();
                        return serde_json::to_value(matches)
                            .map_err(|error| ExtensionError::Runtime(error.to_string()));
                    }
                }
            }
        }
        matches.sort();
        serde_json::to_value(matches).map_err(|error| ExtensionError::Runtime(error.to_string()))
    }

    fn canonical_workspace_file(&self, uri: &str) -> Result<PathBuf, ExtensionError> {
        let root = self.workspace_root()?;
        let parsed = Url::parse(uri).map_err(|error| {
            ExtensionError::InvalidRequest(format!("invalid file URI: {error}"))
        })?;
        if parsed.scheme() != "file" {
            return Err(ExtensionError::InvalidRequest(
                "workspace documents must use file URIs".to_owned(),
            ));
        }
        if !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(ExtensionError::InvalidRequest(
                "workspace file URIs cannot contain credentials, queries or fragments".to_owned(),
            ));
        }
        let path = parsed.to_file_path().map_err(|()| {
            ExtensionError::InvalidRequest("workspace URI is not a valid file path".to_owned())
        })?;
        let canonical = fs::canonicalize(&path).map_err(|error| {
            ExtensionError::io(format!("could not resolve {}", path.display()), error)
        })?;
        if !canonical.starts_with(&root) || !canonical.is_file() {
            return Err(ExtensionError::PermissionDenied(format!(
                "{} is outside the active workspace or is not a file",
                canonical.display()
            )));
        }
        Ok(canonical)
    }

    fn workspace_root(&self) -> Result<PathBuf, ExtensionError> {
        read_lock(&self.shared.workspace_root, "extension workspace")?
            .clone()
            .ok_or_else(|| ExtensionError::InvalidRequest("no workspace is open".to_owned()))
    }

    async fn network_request(
        &self,
        manifest: &ExtensionManifest,
        payload: NetworkRequestPayload,
        cancellation: Arc<Cancellation>,
    ) -> Result<Value, ExtensionError> {
        let _network_slot = self
            .shared
            .network_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                ExtensionError::Conflict("extension network pool is at capacity".to_owned())
            })?;
        let method = Method::from_bytes(payload.method.as_bytes()).map_err(|error| {
            ExtensionError::InvalidRequest(format!("invalid HTTP method: {error}"))
        })?;
        if !matches!(
            method,
            Method::GET | Method::POST | Method::PUT | Method::PATCH | Method::DELETE
        ) {
            return Err(ExtensionError::InvalidRequest(
                "HTTP method is unsupported".to_owned(),
            ));
        }
        if payload
            .body
            .as_ref()
            .is_some_and(|body| body.len() > MAX_NETWORK_REQUEST_BODY_BYTES)
        {
            return Err(ExtensionError::InvalidRequest(format!(
                "network request body exceeds {MAX_NETWORK_REQUEST_BODY_BYTES} bytes"
            )));
        }
        let maximum_response_bytes = payload
            .maximum_response_bytes
            .unwrap_or(DEFAULT_NETWORK_RESPONSE_BYTES);
        if !(1..=MAX_NETWORK_RESPONSE_BYTES).contains(&maximum_response_bytes) {
            return Err(ExtensionError::InvalidRequest(format!(
                "maximum response size must be between 1 and {MAX_NETWORK_RESPONSE_BYTES} bytes"
            )));
        }
        let headers = request_headers(&payload.headers)?;
        let operation = self.network_request_inner(
            manifest,
            payload,
            method,
            headers,
            maximum_response_bytes,
            cancellation.clone(),
        );
        tokio::select! {
            () = cancellation.cancelled() => Err(ExtensionError::Cancelled),
            result = tokio::time::timeout(NETWORK_DEADLINE, operation) => {
                result.map_err(|_| ExtensionError::DeadlineExceeded)?
            }
        }
    }

    async fn network_request_inner(
        &self,
        manifest: &ExtensionManifest,
        payload: NetworkRequestPayload,
        method: Method,
        headers: HeaderMap,
        maximum_response_bytes: usize,
        cancellation: Arc<Cancellation>,
    ) -> Result<Value, ExtensionError> {
        let mut current_url = Url::parse(&payload.url)
            .map_err(|error| ExtensionError::InvalidRequest(format!("invalid URL: {error}")))?;
        let mut headers = headers;
        for redirect_count in 0..=MAX_NETWORK_REDIRECTS {
            validate_network_permission(manifest, &current_url, &method)?;
            let resolution = resolve_network_destination(&current_url).await?;
            let client = match resolution {
                Some((domain, addresses)) => network_client_builder()
                    .resolve_to_addrs(&domain, &addresses)
                    .build()
                    .map_err(|error| {
                        ExtensionError::Runtime(format!(
                            "could not create a pinned extension HTTP client: {error}"
                        ))
                    })?,
                None => self.shared.network_client.clone(),
            };
            let mut builder = client
                .request(method.clone(), current_url.clone())
                .headers(headers.clone());
            if let Some(body) = payload.body.clone() {
                builder = builder.body(body);
            }
            let mut response = tokio::select! {
                () = cancellation.cancelled() => return Err(ExtensionError::Cancelled),
                result = builder.send() => result.map_err(|error| {
                    ExtensionError::Runtime(format!("extension network request failed: {error}"))
                })?,
            };
            if response.status().is_redirection() {
                if !matches!(method, Method::GET) {
                    return Err(ExtensionError::PermissionDenied(
                        "redirects are disabled for mutating extension requests".to_owned(),
                    ));
                }
                if redirect_count == MAX_NETWORK_REDIRECTS {
                    return Err(ExtensionError::InvalidRequest(format!(
                        "network request exceeded {MAX_NETWORK_REDIRECTS} redirects"
                    )));
                }
                let location = response
                    .headers()
                    .get(LOCATION)
                    .ok_or_else(|| {
                        ExtensionError::InvalidRequest(
                            "network redirect did not include a location".to_owned(),
                        )
                    })?
                    .to_str()
                    .map_err(|_| {
                        ExtensionError::InvalidRequest(
                            "network redirect location is not valid text".to_owned(),
                        )
                    })?;
                let redirected_url = current_url.join(location).map_err(|error| {
                    ExtensionError::InvalidRequest(format!("invalid network redirect: {error}"))
                })?;
                if redirected_url.origin() != current_url.origin() {
                    headers.remove(AUTHORIZATION);
                }
                current_url = redirected_url;
                continue;
            }
            let status = response.status().as_u16();
            if response
                .headers()
                .get(CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<usize>().ok())
                .is_some_and(|length| length > maximum_response_bytes)
            {
                return Err(ExtensionError::InvalidRequest(format!(
                    "network response exceeds {maximum_response_bytes} bytes"
                )));
            }
            let response_headers = response_headers(response.headers())?;
            let mut body = Vec::new();
            loop {
                let chunk = tokio::select! {
                    () = cancellation.cancelled() => return Err(ExtensionError::Cancelled),
                    chunk = response.chunk() => chunk.map_err(|error| {
                        ExtensionError::Runtime(format!("could not read network response: {error}"))
                    })?,
                };
                let Some(chunk) = chunk else {
                    break;
                };
                if body.len().saturating_add(chunk.len()) > maximum_response_bytes {
                    return Err(ExtensionError::InvalidRequest(format!(
                        "network response exceeds {maximum_response_bytes} bytes"
                    )));
                }
                body.extend_from_slice(&chunk);
            }
            let body = String::from_utf8(body).map_err(|_| {
                ExtensionError::InvalidRequest("network response is not UTF-8".to_owned())
            })?;
            return Ok(json!({
                "status": status,
                "headers": response_headers,
                "body": body,
            }));
        }
        Err(ExtensionError::Runtime(
            "network redirect resolution failed".to_owned(),
        ))
    }

    async fn execute_process(
        &self,
        manifest: &ExtensionManifest,
        grant: String,
        cancellation: Arc<Cancellation>,
    ) -> Result<Value, ExtensionError> {
        let permission = manifest
            .permissions
            .processes
            .iter()
            .find(|permission| permission.id == grant)
            .ok_or_else(|| {
                ExtensionError::PermissionDenied(format!("process grant {grant} was not declared"))
            })?
            .clone();
        let _process_slot = self
            .shared
            .process_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                ExtensionError::Conflict("extension process pool is at capacity".to_owned())
            })?;
        let executable = resolve_process_executable(&permission.executable)?;
        let mut command = Command::new(executable);
        command
            .args(&permission.arguments)
            .env_clear()
            .env("NO_COLOR", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for name in ["SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        if let Ok(workspace_root) = self.workspace_root() {
            command.current_dir(workspace_root);
        }
        let mut child = command.spawn().map_err(|error| {
            ExtensionError::io(
                format!("could not start process grant {}", permission.id),
                error,
            )
        })?;
        let standard_output = match child.stdout.take() {
            Some(output) => output,
            None => {
                terminate_process(&mut child).await;
                return Err(ExtensionError::Runtime(
                    "process stdout pipe is unavailable".to_owned(),
                ));
            }
        };
        let standard_error = match child.stderr.take() {
            Some(output) => output,
            None => {
                terminate_process(&mut child).await;
                return Err(ExtensionError::Runtime(
                    "process stderr pipe is unavailable".to_owned(),
                ));
            }
        };

        let outcome = {
            let completion = async {
                tokio::try_join!(
                    async {
                        child.wait().await.map_err(|error| {
                            ExtensionError::io("could not wait for extension process", error)
                        })
                    },
                    read_bounded_output(standard_output),
                    read_bounded_output(standard_error),
                )
            };
            tokio::pin!(completion);
            tokio::select! {
                () = cancellation.cancelled() => ProcessWaitOutcome::Cancelled,
                () = tokio::time::sleep(PROCESS_DEADLINE) => ProcessWaitOutcome::DeadlineExceeded,
                result = completion => ProcessWaitOutcome::Completed(result),
            }
        };
        let (status, standard_output, standard_error) = match outcome {
            ProcessWaitOutcome::Completed(Ok(result)) => result,
            ProcessWaitOutcome::Completed(Err(error)) => {
                terminate_process(&mut child).await;
                return Err(error);
            }
            ProcessWaitOutcome::Cancelled => {
                terminate_process(&mut child).await;
                return Err(ExtensionError::Cancelled);
            }
            ProcessWaitOutcome::DeadlineExceeded => {
                terminate_process(&mut child).await;
                return Err(ExtensionError::DeadlineExceeded);
            }
        };
        Ok(json!({
            "exitCode": status.code().unwrap_or(-1),
            "standardOutput": standard_output,
            "standardError": standard_error,
        }))
    }

    fn create_output(
        &self,
        manifest: &ExtensionManifest,
        name: String,
    ) -> Result<Value, ExtensionError> {
        validate_text("output channel name", &name, 128)?;
        let mut outputs = lock(&self.shared.outputs, "extension output channels")?;
        if outputs
            .values()
            .filter(|output| output.extension_id == manifest.id)
            .count()
            >= MAX_OUTPUT_CHANNELS_PER_EXTENSION
        {
            return Err(ExtensionError::Conflict(format!(
                "extension {} exceeded its {MAX_OUTPUT_CHANNELS_PER_EXTENSION}-channel output limit",
                manifest.id
            )));
        }
        let sequence = self.shared.next_output_id.fetch_add(1, Ordering::Relaxed);
        let resource_id = format!("{}:{sequence}", manifest.id);
        outputs.insert(
            resource_id.clone(),
            OutputResource {
                extension_id: manifest.id.clone(),
                name,
                content: String::new(),
                visible: false,
            },
        );
        Ok(Value::String(resource_id))
    }

    fn append_output(
        &self,
        manifest: &ExtensionManifest,
        resource_id: &str,
        value: &str,
    ) -> Result<Value, ExtensionError> {
        if value.len() > MAX_OUTPUT_APPEND_BYTES {
            return Err(ExtensionError::InvalidRequest(format!(
                "output append exceeds {MAX_OUTPUT_APPEND_BYTES} bytes"
            )));
        }
        let mut outputs = lock(&self.shared.outputs, "extension output channels")?;
        let output = owned_output_mut(&mut outputs, &manifest.id, resource_id)?;
        if output.content.len().saturating_add(value.len()) > MAX_OUTPUT_CHANNEL_BYTES {
            return Err(ExtensionError::InvalidRequest(format!(
                "output channel exceeds {MAX_OUTPUT_CHANNEL_BYTES} bytes"
            )));
        }
        output.content.push_str(value);
        Ok(Value::Null)
    }

    fn clear_output(
        &self,
        manifest: &ExtensionManifest,
        resource_id: &str,
    ) -> Result<Value, ExtensionError> {
        let mut outputs = lock(&self.shared.outputs, "extension output channels")?;
        owned_output_mut(&mut outputs, &manifest.id, resource_id)?
            .content
            .clear();
        Ok(Value::Null)
    }

    fn show_output(
        &self,
        state: &SideralExtensionState,
        manifest: &ExtensionManifest,
        resource_id: &str,
    ) -> Result<Value, ExtensionError> {
        let view = {
            let mut outputs = lock(&self.shared.outputs, "extension output channels")?;
            let output = owned_output_mut(&mut outputs, &manifest.id, resource_id)?;
            output.visible = true;
            output_view(resource_id, output)
        };
        state
            .send_client_instruction(ExtensionClientInstruction::OutputChanged { channel: view })?;
        Ok(Value::Null)
    }

    fn flush_output(
        &self,
        state: &SideralExtensionState,
        manifest: &ExtensionManifest,
        resource_id: &str,
    ) -> Result<Value, ExtensionError> {
        let view = {
            let outputs = lock(&self.shared.outputs, "extension output channels")?;
            let output = owned_output(&outputs, &manifest.id, resource_id)?;
            output_view(resource_id, output)
        };
        state
            .send_client_instruction(ExtensionClientInstruction::OutputChanged { channel: view })?;
        Ok(Value::Null)
    }

    fn dispose_output(
        &self,
        state: &SideralExtensionState,
        manifest: &ExtensionManifest,
        resource_id: &str,
    ) -> Result<Value, ExtensionError> {
        let mut outputs = lock(&self.shared.outputs, "extension output channels")?;
        owned_output(&outputs, &manifest.id, resource_id)?;
        outputs.remove(resource_id);
        drop(outputs);
        state.send_client_instruction(ExtensionClientInstruction::OutputDisposed {
            resource_id: resource_id.to_owned(),
        })?;
        Ok(Value::Null)
    }
}

enum ProcessWaitOutcome {
    Completed(Result<(std::process::ExitStatus, String, String), ExtensionError>),
    Cancelled,
    DeadlineExceeded,
}

#[derive(Clone, Copy)]
enum StoreKind {
    Storage,
    Configuration,
}

impl StoreKind {
    const fn file_name(self) -> &'static str {
        match self {
            Self::Storage => "storage.json",
            Self::Configuration => "configuration.json",
        }
    }

    const fn limit(self) -> u64 {
        match self {
            Self::Storage => STORAGE_DOCUMENT_LIMIT_BYTES,
            Self::Configuration => CONFIGURATION_DOCUMENT_LIMIT_BYTES,
        }
    }

    fn gate(self, shared: &BrokerShared) -> &AsyncMutex<()> {
        match self {
            Self::Storage => &shared.storage_gate,
            Self::Configuration => &shared.configuration_gate,
        }
    }
}

fn key_value_schema_version() -> u8 {
    KEY_VALUE_SCHEMA_VERSION
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

fn require_workspace_permission(
    manifest: &ExtensionManifest,
    write: bool,
) -> Result<(), ExtensionError> {
    let permitted = match (manifest.permissions.workspace, write) {
        (WorkspaceAccess::Read | WorkspaceAccess::ReadWrite, false)
        | (WorkspaceAccess::ReadWrite, true) => true,
        (WorkspaceAccess::None | WorkspaceAccess::Read, true) | (WorkspaceAccess::None, false) => {
            false
        }
    };
    if permitted {
        Ok(())
    } else {
        Err(ExtensionError::PermissionDenied(format!(
            "extension {} does not have {} workspace access",
            manifest.id,
            if write { "write" } else { "read" }
        )))
    }
}

fn validate_network_permission(
    manifest: &ExtensionManifest,
    url: &Url,
    method: &Method,
) -> Result<(), ExtensionError> {
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(ExtensionError::InvalidRequest(
            "network URLs cannot contain credentials or fragments".to_owned(),
        ));
    }
    let origin = url.origin().ascii_serialization();
    let permitted_method = match *method {
        Method::GET => NetworkMethod::GET,
        Method::POST => NetworkMethod::POST,
        Method::PUT => NetworkMethod::PUT,
        Method::PATCH => NetworkMethod::PATCH,
        Method::DELETE => NetworkMethod::DELETE,
        _ => {
            return Err(ExtensionError::InvalidRequest(
                "HTTP method is unsupported".to_owned(),
            ));
        }
    };
    let allowed = manifest.permissions.network.iter().any(|permission| {
        Url::parse(&permission.origin)
            .is_ok_and(|allowed| allowed.origin().ascii_serialization() == origin)
            && permission.methods.contains(&permitted_method)
    });
    if allowed {
        Ok(())
    } else {
        Err(ExtensionError::PermissionDenied(format!(
            "extension {} did not declare {method} access to {origin}",
            manifest.id
        )))
    }
}

fn network_client_builder() -> reqwest::ClientBuilder {
    Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(NETWORK_DEADLINE)
        .user_agent("Sideral-Extension-Host/1")
}

async fn resolve_network_destination(
    url: &Url,
) -> Result<Option<(String, Vec<SocketAddr>)>, ExtensionError> {
    let host = url
        .host()
        .ok_or_else(|| ExtensionError::InvalidRequest(format!("network URL {url} has no host")))?;
    let port = url.port_or_known_default().ok_or_else(|| {
        ExtensionError::InvalidRequest(format!("network URL {url} has no valid port"))
    })?;
    match host {
        Host::Ipv4(address) => {
            if !address.is_loopback() && !is_public_ipv4(address) {
                return Err(ExtensionError::PermissionDenied(
                    "network destination is a private or reserved address".to_owned(),
                ));
            }
            Ok(None)
        }
        Host::Ipv6(address) => {
            if !address.is_loopback() && !is_public_ipv6(address) {
                return Err(ExtensionError::PermissionDenied(
                    "network destination is a private or reserved address".to_owned(),
                ));
            }
            Ok(None)
        }
        Host::Domain(domain) => {
            let normalized = domain.trim_end_matches('.').to_ascii_lowercase();
            if normalized.ends_with(".localhost") || normalized.ends_with(".local") {
                return Err(ExtensionError::PermissionDenied(
                    "network requests cannot target local hostnames".to_owned(),
                ));
            }
            let domain = domain.to_owned();
            let lookup_domain = domain.clone();
            let mut addresses = run_blocking(move || {
                (lookup_domain.as_str(), port)
                    .to_socket_addrs()
                    .map(|addresses| addresses.collect::<Vec<_>>())
                    .map_err(|error| {
                        ExtensionError::Runtime(format!("could not resolve network host: {error}"))
                    })
            })
            .await?;
            addresses.sort_unstable();
            addresses.dedup();
            let valid = if normalized == "localhost" {
                addresses.iter().all(|address| address.ip().is_loopback())
            } else {
                addresses
                    .iter()
                    .all(|address| is_public_address(address.ip()))
            };
            if addresses.is_empty() || !valid {
                return Err(ExtensionError::PermissionDenied(
                    "network destination resolved to a private or reserved address".to_owned(),
                ));
            }
            Ok(Some((domain, addresses)))
        }
    }
}

fn response_headers(headers: &HeaderMap) -> Result<BTreeMap<String, String>, ExtensionError> {
    if headers.len() > MAX_NETWORK_RESPONSE_HEADERS {
        return Err(ExtensionError::InvalidRequest(format!(
            "network response exceeds {MAX_NETWORK_RESPONSE_HEADERS} headers"
        )));
    }
    let mut total_bytes = 0_usize;
    let mut result = BTreeMap::new();
    for (name, value) in headers {
        total_bytes = total_bytes
            .saturating_add(name.as_str().len())
            .saturating_add(value.as_bytes().len());
        if total_bytes > MAX_RESPONSE_HEADER_BYTES {
            return Err(ExtensionError::InvalidRequest(format!(
                "network response headers exceed {MAX_RESPONSE_HEADER_BYTES} bytes"
            )));
        }
        if let Ok(value) = value.to_str() {
            result.insert(name.as_str().to_owned(), value.to_owned());
        }
    }
    Ok(result)
}

fn is_public_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let [first, second, third, _] = address.octets();
    !(address.is_private()
        || address.is_loopback()
        || address.is_link_local()
        || address.is_broadcast()
        || address.is_documentation()
        || address.is_unspecified()
        || address.is_multicast()
        || first == 0
        || (first == 100 && (64..=127).contains(&second))
        || (first == 192 && second == 0 && third == 0)
        || (first == 198 && (18..=19).contains(&second))
        || first >= 240)
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    if let Some(ipv4) = address.to_ipv4_mapped() {
        return is_public_ipv4(ipv4);
    }
    let octets = address.octets();
    !(address.is_loopback()
        || address.is_unspecified()
        || address.is_multicast()
        || (octets[0] & 0xfe) == 0xfc
        || (octets[0] == 0xfe && (octets[1] & 0xc0) == 0x80)
        || (octets[0] == 0x20 && octets[1] == 0x01 && octets[2] == 0x0d && octets[3] == 0xb8))
}

fn request_headers(headers: &BTreeMap<String, String>) -> Result<HeaderMap, ExtensionError> {
    if headers.len() > MAX_NETWORK_HEADERS {
        return Err(ExtensionError::InvalidRequest(format!(
            "network request exceeds {MAX_NETWORK_HEADERS} headers"
        )));
    }
    let mut result = HeaderMap::new();
    let mut total_bytes = 0_usize;
    for (name, value) in headers {
        total_bytes = total_bytes
            .saturating_add(name.len())
            .saturating_add(value.len());
        if total_bytes > MAX_HEADER_BYTES {
            return Err(ExtensionError::InvalidRequest(format!(
                "network headers exceed {MAX_HEADER_BYTES} bytes"
            )));
        }
        let normalized_name = name.to_ascii_lowercase();
        if matches!(
            normalized_name.as_str(),
            "connection"
                | "content-length"
                | "cookie"
                | "host"
                | "proxy-authorization"
                | "te"
                | "trailer"
                | "transfer-encoding"
                | "upgrade"
        ) {
            return Err(ExtensionError::PermissionDenied(format!(
                "network header {name} is controlled by the broker"
            )));
        }
        let name = HeaderName::from_str(name).map_err(|error| {
            ExtensionError::InvalidRequest(format!("invalid network header name: {error}"))
        })?;
        let value = HeaderValue::from_str(value).map_err(|error| {
            ExtensionError::InvalidRequest(format!("invalid network header value: {error}"))
        })?;
        result.insert(name, value);
    }
    Ok(result)
}

fn resolve_process_executable(executable: &str) -> Result<PathBuf, ExtensionError> {
    let declared = Path::new(executable);
    if declared.is_absolute() {
        return canonical_executable(declared).ok_or_else(|| {
            ExtensionError::InvalidRequest(format!(
                "declared process executable {executable} is unavailable"
            ))
        });
    }
    if declared.components().count() != 1 {
        return Err(ExtensionError::PermissionDenied(
            "relative process executable paths are not allowed".to_owned(),
        ));
    }
    let search_path = std::env::var_os("PATH").ok_or_else(|| {
        ExtensionError::Runtime("the operating system process PATH is unavailable".to_owned())
    })?;
    for directory in std::env::split_paths(&search_path).filter(|path| path.is_absolute()) {
        let candidate = directory.join(declared);
        if let Some(executable) = canonical_executable(&candidate) {
            return Ok(executable);
        }
        #[cfg(windows)]
        if declared.extension().is_none() {
            for extension in ["exe", "com"] {
                let mut candidate = candidate.clone();
                candidate.set_extension(extension);
                if let Some(executable) = canonical_executable(&candidate) {
                    return Ok(executable);
                }
            }
        }
    }
    Err(ExtensionError::InvalidRequest(format!(
        "declared process executable {executable} was not found on the system PATH"
    )))
}

fn canonical_executable(path: &Path) -> Option<PathBuf> {
    let canonical = fs::canonicalize(path).ok()?;
    let metadata = fs::metadata(&canonical).ok()?;
    if !metadata.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if metadata.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some(canonical)
}

async fn read_bounded_output(reader: impl AsyncRead + Unpin) -> Result<String, ExtensionError> {
    let mut bytes = Vec::new();
    let limit = u64::try_from(MAX_PROCESS_OUTPUT_BYTES)
        .map_err(|_| ExtensionError::Runtime("process output limit is invalid".to_owned()))?;
    reader
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| ExtensionError::io("could not read extension process output", error))?;
    if bytes.len() > MAX_PROCESS_OUTPUT_BYTES {
        return Err(ExtensionError::InvalidRequest(format!(
            "process output exceeds {MAX_PROCESS_OUTPUT_BYTES} bytes"
        )));
    }
    String::from_utf8(bytes)
        .map_err(|_| ExtensionError::InvalidRequest("process output is not UTF-8".to_owned()))
}

async fn terminate_process(child: &mut tokio::process::Child) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

fn send_message(
    state: &SideralExtensionState,
    manifest: &ExtensionManifest,
    severity: MessageSeverity,
    message: String,
) -> Result<Value, ExtensionError> {
    validate_text("message", &message, MAX_MESSAGE_BYTES)?;
    state.send_client_instruction(ExtensionClientInstruction::ShowMessage {
        extension_id: manifest.id.clone(),
        severity,
        message,
    })?;
    Ok(Value::Null)
}

fn output_view(resource_id: &str, output: &OutputResource) -> OutputChannelView {
    OutputChannelView {
        resource_id: resource_id.to_owned(),
        extension_id: output.extension_id.clone(),
        name: output.name.clone(),
        content: output.content.clone(),
        visible: output.visible,
    }
}

fn owned_output<'a>(
    outputs: &'a HashMap<String, OutputResource>,
    extension_id: &str,
    resource_id: &str,
) -> Result<&'a OutputResource, ExtensionError> {
    let output = outputs.get(resource_id).ok_or_else(|| {
        ExtensionError::InvalidRequest(format!("output channel {resource_id} does not exist"))
    })?;
    if output.extension_id != extension_id {
        return Err(ExtensionError::PermissionDenied(
            "output channel belongs to another extension".to_owned(),
        ));
    }
    Ok(output)
}

fn owned_output_mut<'a>(
    outputs: &'a mut HashMap<String, OutputResource>,
    extension_id: &str,
    resource_id: &str,
) -> Result<&'a mut OutputResource, ExtensionError> {
    let output = outputs.get_mut(resource_id).ok_or_else(|| {
        ExtensionError::InvalidRequest(format!("output channel {resource_id} does not exist"))
    })?;
    if output.extension_id != extension_id {
        return Err(ExtensionError::PermissionDenied(
            "output channel belongs to another extension".to_owned(),
        ));
    }
    Ok(output)
}

fn read_key_value_document(path: &Path, limit: u64) -> Result<KeyValueDocument, ExtensionError> {
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

fn write_key_value_document(
    path: &Path,
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

fn track_document_version(
    versions: &mut HashMap<PathBuf, TrackedDocument>,
    path: &Path,
    content_sha256: &str,
) -> u64 {
    match versions.get_mut(path) {
        Some(document) if document.content_sha256 == content_sha256 => document.version,
        Some(document) => {
            document.content_sha256 = content_sha256.to_owned();
            document.version = document.version.saturating_add(1);
            document.version
        }
        None => {
            versions.insert(
                path.to_path_buf(),
                TrackedDocument {
                    content_sha256: content_sha256.to_owned(),
                    version: 1,
                },
            );
            1
        }
    }
}

fn file_uri(path: &Path) -> Result<String, ExtensionError> {
    Url::from_file_path(path)
        .map(|uri| uri.to_string())
        .map_err(|()| ExtensionError::Runtime(format!("{} has no file URI", path.display())))
}

fn language_id(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("css") => "css",
        Some("html" | "htm") => "html",
        Some("js" | "mjs" | "cjs") => "javascript",
        Some("json" | "jsonc") => "json",
        Some("md") => "markdown",
        Some("py") => "python",
        Some("rs") => "rust",
        Some("ts" | "mts" | "cts") => "typescript",
        Some("tsx") => "typescriptreact",
        Some("jsx") => "javascriptreact",
        Some("toml") => "toml",
        Some("xml") => "xml",
        Some("yaml" | "yml") => "yaml",
        _ => "plaintext",
    }
}

fn validate_store_key(key: &str) -> Result<(), ExtensionError> {
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

fn validate_text(kind: &str, value: &str, maximum_bytes: usize) -> Result<(), ExtensionError> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > maximum_bytes
        || value.contains('\0')
    {
        return Err(ExtensionError::InvalidRequest(format!(
            "{kind} must be clean text between 1 and {maximum_bytes} bytes"
        )));
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
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
        Cancellation, CapabilityBroker, ExtensionError, FindFilesPayload, RequestKey, StoreKind,
        WriteDocumentPayload, file_uri, is_public_ipv4, validate_store_key,
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

        let first = broker.read_workspace_document_blocking(&uri)?;
        assert_eq!(first["version"], serde_json::json!(1));
        let updated = broker.write_workspace_document_blocking(WriteDocumentPayload {
            uri: uri.clone(),
            content: "second".to_owned(),
            expected_version: 1,
        })?;
        assert_eq!(updated["version"], serde_json::json!(2));

        let stale = broker.write_workspace_document_blocking(WriteDocumentPayload {
            uri,
            content: "stale".to_owned(),
            expected_version: 1,
        });
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
