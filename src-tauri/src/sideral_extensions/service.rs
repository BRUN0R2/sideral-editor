use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use semver::Version;
use serde_json::Value;
use sideral_extension_core::CommandInvocation;
use tauri::{
    AppHandle, Manager, WebviewWindow,
    ipc::{Channel, Response},
};
use tokio::{
    sync::{Mutex as AsyncMutex, OwnedMutexGuard, Semaphore, oneshot},
    task::JoinSet,
};

use super::{
    broker::CapabilityBroker,
    error::ExtensionError,
    protocol::{
        ActivationReason, BrokerRequest, BrokerResponse, COMMAND_EXECUTION_DEADLINE_MILLISECONDS,
        ClientHandshake, DeactivationReason, EXTENSION_PROTOCOL_VERSION,
        ExtensionClientInstruction, ExtensionRuntimeState, ExtensionSnapshot, HostEvent,
        HostHandshake, HostInstruction, PackageInspectionResult, ProtocolFailure,
        RuntimeDiagnostic, TextDocumentView, WORKER_ACTIVATION_DEADLINE_MILLISECONDS,
        WORKER_SHUTDOWN_GRACE_MILLISECONDS, WORKER_START_DEADLINE_MILLISECONDS,
    },
    registry::ExtensionRegistry,
};

const MAIN_WINDOW_LABEL: &str = "main";
const HOST_RESPONSE_MARGIN_MILLISECONDS: u64 = 2_000;
const MAX_BROKER_REQUEST_ID_BYTES: usize = 128;
const MAX_CONCURRENT_ACTIVATIONS: usize = 8;
const MAX_EXTENSION_CLIENTS: usize = 4;
const MAX_COMMAND_ARGUMENT_BYTES: usize = 256 * 1024;
const MAX_COMMAND_RESULT_BYTES: usize = 1024 * 1024;
const MAX_ACTIVE_DOCUMENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_PROTOCOL_FAILURE_MESSAGE_BYTES: usize = 4 * 1024;

type PendingOutcome = Result<Option<Value>, ExtensionError>;
type PendingRequests = HashMap<String, oneshot::Sender<PendingOutcome>>;

struct HostConnection {
    session_id: u64,
    session_token: String,
    channel: Channel<HostInstruction>,
}

struct RuntimeCoordinator {
    extensions: BTreeMap<String, RuntimeDiagnostic>,
}

impl RuntimeCoordinator {
    fn diagnostic_mut(&mut self, extension_id: &str) -> &mut RuntimeDiagnostic {
        self.extensions.entry(extension_id.to_owned()).or_default()
    }

    fn reset_for_new_host(&mut self) {
        for diagnostic in self.extensions.values_mut() {
            diagnostic.state = ExtensionRuntimeState::Dormant;
            diagnostic.generation = diagnostic.generation.saturating_add(1);
            diagnostic.activation_reason = None;
        }
    }
}

struct ExtensionService {
    registry: Mutex<ExtensionRegistry>,
    broker: CapabilityBroker,
    runtimes: Mutex<RuntimeCoordinator>,
    host: Mutex<Option<HostConnection>>,
    clients: Mutex<BTreeMap<u64, Channel<ExtensionClientInstruction>>>,
    pending: Mutex<PendingRequests>,
    mutation_gate: Arc<AsyncMutex<()>>,
    next_request_id: AtomicU64,
    next_session_id: AtomicU64,
    next_client_id: AtomicU64,
    next_snapshot_sequence: AtomicU64,
}

#[derive(Clone)]
pub struct SideralExtensionState {
    service: Arc<ExtensionService>,
}

impl SideralExtensionState {
    pub fn load(app: &AppHandle) -> Result<Self, ExtensionError> {
        let app_version =
            Version::parse(&app.package_info().version.to_string()).map_err(|error| {
                ExtensionError::Runtime(format!("application version is invalid: {error}"))
            })?;
        let root = app
            .path()
            .app_data_dir()
            .map_err(|error| ExtensionError::Runtime(error.to_string()))?
            .join("extensions");
        let registry = ExtensionRegistry::load(root.clone(), app_version)?;
        let broker = CapabilityBroker::new(root)?;
        Ok(Self {
            service: Arc::new(ExtensionService {
                registry: Mutex::new(registry),
                broker,
                runtimes: Mutex::new(RuntimeCoordinator {
                    extensions: BTreeMap::new(),
                }),
                host: Mutex::new(None),
                clients: Mutex::new(BTreeMap::new()),
                pending: Mutex::new(HashMap::new()),
                mutation_gate: Arc::new(AsyncMutex::new(())),
                next_request_id: AtomicU64::new(1),
                next_session_id: AtomicU64::new(1),
                next_client_id: AtomicU64::new(1),
                next_snapshot_sequence: AtomicU64::new(1),
            }),
        })
    }

    pub fn connect_host(
        &self,
        window: &WebviewWindow,
        channel: Channel<HostInstruction>,
    ) -> Result<HostHandshake, ExtensionError> {
        require_window(window, MAIN_WINDOW_LABEL)?;
        let mut token_bytes = [0_u8; 32];
        getrandom::fill(&mut token_bytes).map_err(|error| {
            ExtensionError::Runtime(format!("could not create host session token: {error}"))
        })?;
        let session_token = URL_SAFE_NO_PAD.encode(token_bytes);
        let session_id = self.service.next_session_id.fetch_add(1, Ordering::Relaxed);

        {
            let mut host = lock(&self.service.host, "extension host")?;
            *host = Some(HostConnection {
                session_id,
                session_token: session_token.clone(),
                channel,
            });
        }
        self.service.broker.cancel_all();
        lock(&self.service.runtimes, "extension runtime state")?.reset_for_new_host();
        self.fail_all_pending(ExtensionError::HostUnavailable)?;
        self.publish_snapshot()?;

        Ok(HostHandshake {
            protocol_version: EXTENSION_PROTOCOL_VERSION,
            supported_api_versions: vec![1],
            session_id,
            session_token,
            shutdown_grace_milliseconds: WORKER_SHUTDOWN_GRACE_MILLISECONDS,
        })
    }

    pub fn connect_client(
        &self,
        window: &WebviewWindow,
        channel: Channel<ExtensionClientInstruction>,
    ) -> Result<ClientHandshake, ExtensionError> {
        require_window(window, MAIN_WINDOW_LABEL)?;
        let connection_id = self.service.next_client_id.fetch_add(1, Ordering::Relaxed);
        let mut clients = lock(&self.service.clients, "extension clients")?;
        if clients.len() >= MAX_EXTENSION_CLIENTS {
            return Err(ExtensionError::Conflict(format!(
                "at most {MAX_EXTENSION_CLIENTS} extension clients can be connected"
            )));
        }
        clients.insert(connection_id, channel);
        drop(clients);
        Ok(ClientHandshake {
            connection_id,
            snapshot: self.snapshot()?,
            outputs: self.service.broker.output_views()?,
            previews: self.service.broker.preview_views()?,
        })
    }

    pub fn disconnect_client(
        &self,
        window: &WebviewWindow,
        connection_id: u64,
    ) -> Result<(), ExtensionError> {
        require_window(window, MAIN_WINDOW_LABEL)?;
        lock(&self.service.clients, "extension clients")?.remove(&connection_id);
        Ok(())
    }

    pub fn disconnect_host_session(
        &self,
        window: &WebviewWindow,
        session_id: u64,
    ) -> Result<(), ExtensionError> {
        require_window(window, MAIN_WINDOW_LABEL)?;
        let disconnected = {
            let mut host = lock(&self.service.host, "extension host")?;
            if host
                .as_ref()
                .is_some_and(|connection| connection.session_id == session_id)
            {
                *host = None;
                true
            } else {
                false
            }
        };
        if disconnected {
            self.reset_disconnected_host()?;
        }
        Ok(())
    }

    pub fn require_main_window(&self, window: &WebviewWindow) -> Result<(), ExtensionError> {
        require_window(window, MAIN_WINDOW_LABEL)
    }

    pub async fn lock_mutations(&self) -> OwnedMutexGuard<()> {
        self.service.mutation_gate.clone().lock_owned().await
    }

    pub fn set_workspace_root(
        &self,
        window: &WebviewWindow,
        root: Option<std::path::PathBuf>,
    ) -> Result<(), ExtensionError> {
        require_window(window, MAIN_WINDOW_LABEL)?;
        self.service.broker.set_workspace_root(root)
    }

    pub fn snapshot(&self) -> Result<ExtensionSnapshot, ExtensionError> {
        let registry = lock(&self.service.registry, "extension registry")?;
        let runtimes = lock(&self.service.runtimes, "extension runtime state")?;
        let mut snapshot = registry.snapshot(&runtimes.extensions);
        snapshot.sequence = self
            .service
            .next_snapshot_sequence
            .fetch_add(1, Ordering::Relaxed);
        Ok(snapshot)
    }

    pub async fn execute_command(
        &self,
        command_id: String,
        arguments: Vec<Value>,
        active_text_document: Option<TextDocumentView>,
    ) -> Result<Option<Value>, ExtensionError> {
        validate_command_id(&command_id)?;
        let argument_bytes = serde_json::to_vec(&arguments)
            .map_err(|error| ExtensionError::InvalidRequest(error.to_string()))?
            .len();
        if argument_bytes > MAX_COMMAND_ARGUMENT_BYTES {
            return Err(ExtensionError::InvalidRequest(format!(
                "command arguments exceed {MAX_COMMAND_ARGUMENT_BYTES} bytes"
            )));
        }
        self.require_host_connected()?;

        let (extension_id, api_version, bundle_sha256, command_ids, invocation) = {
            let registry = lock(&self.service.registry, "extension registry")?;
            let installed = registry.extension_for_command(&command_id)?;
            registry.active(&installed.active.manifest.id)?;
            let invocation = installed
                .active
                .manifest
                .contributes
                .commands
                .iter()
                .find(|command| command.id == command_id)
                .map(|command| command.invocation)
                .ok_or_else(|| ExtensionError::NotFound(command_id.clone()))?;
            (
                installed.active.manifest.id.clone(),
                installed.active.manifest.api_version,
                installed.active.bundle_sha256.clone(),
                installed
                    .active
                    .manifest
                    .contributes
                    .commands
                    .iter()
                    .map(|command| command.id.clone())
                    .collect::<Vec<_>>(),
                invocation,
            )
        };
        let active_text_document = match invocation {
            CommandInvocation::Workbench => None,
            CommandInvocation::ActiveTextDocument => {
                Some(active_text_document.ok_or_else(|| {
                    ExtensionError::InvalidRequest(format!(
                        "command {command_id} requires an active text document"
                    ))
                })?)
            }
        };
        if let Some(document) = &active_text_document {
            validate_active_text_document(document)?;
        }
        let activation_reason = ActivationReason::Command {
            command_id: command_id.clone(),
        };
        let generation = {
            let mut runtimes = lock(&self.service.runtimes, "extension runtime state")?;
            let diagnostic = runtimes.diagnostic_mut(&extension_id);
            match diagnostic.state {
                ExtensionRuntimeState::Dormant | ExtensionRuntimeState::Stopped => {
                    diagnostic.generation = diagnostic.generation.saturating_add(1);
                    diagnostic.state = ExtensionRuntimeState::Starting;
                    diagnostic.activation_reason = Some(activation_reason.clone());
                    diagnostic.last_error = None;
                }
                ExtensionRuntimeState::Starting
                | ExtensionRuntimeState::Activating
                | ExtensionRuntimeState::Active => {}
                ExtensionRuntimeState::Stopping => {
                    return Err(ExtensionError::InvalidRuntimeState(format!(
                        "extension {extension_id} is stopping"
                    )));
                }
                ExtensionRuntimeState::Failed => {
                    return Err(ExtensionError::InvalidRuntimeState(format!(
                        "extension {extension_id} failed and must be restarted explicitly"
                    )));
                }
            }
            diagnostic.generation
        };
        self.publish_snapshot()?;

        let command_started = std::time::Instant::now();
        let request_id = self.next_request_id();
        let (sender, receiver) = oneshot::channel();
        lock(&self.service.pending, "extension pending requests")?
            .insert(request_id.clone(), sender);
        let instruction = HostInstruction::ExecuteCommand {
            protocol_version: EXTENSION_PROTOCOL_VERSION,
            request_id: request_id.clone(),
            extension_id: extension_id.clone(),
            generation,
            api_version,
            bundle_sha256,
            extension_uri: format!("sideral-extension:/{extension_id}/"),
            storage_uri: format!("sideral-storage:/{extension_id}/"),
            command_ids,
            command_id,
            arguments,
            active_text_document,
            activation_reason,
            start_deadline_milliseconds: WORKER_START_DEADLINE_MILLISECONDS,
            activation_deadline_milliseconds: WORKER_ACTIVATION_DEADLINE_MILLISECONDS,
            execution_deadline_milliseconds: COMMAND_EXECUTION_DEADLINE_MILLISECONDS,
        };
        if let Err(error) = self.send_to_host(instruction) {
            lock(&self.service.pending, "extension pending requests")?.remove(&request_id);
            self.mark_failed(
                &extension_id,
                generation,
                ProtocolFailure {
                    code: error.code().to_owned(),
                    message: error.to_string(),
                },
            )?;
            self.record_command(
                &extension_id,
                generation,
                elapsed_milliseconds(command_started),
                true,
            )?;
            return Err(error);
        }

        let total_deadline = WORKER_START_DEADLINE_MILLISECONDS
            + WORKER_ACTIVATION_DEADLINE_MILLISECONDS
            + COMMAND_EXECUTION_DEADLINE_MILLISECONDS
            + HOST_RESPONSE_MARGIN_MILLISECONDS;
        let outcome =
            match tokio::time::timeout(std::time::Duration::from_millis(total_deadline), receiver)
                .await
            {
                Ok(Ok(result)) => result,
                Ok(Err(_)) => Err(ExtensionError::HostUnavailable),
                Err(_) => {
                    lock(&self.service.pending, "extension pending requests")?.remove(&request_id);
                    let _ = self.send_to_host(HostInstruction::CancelRequest {
                        protocol_version: EXTENSION_PROTOCOL_VERSION,
                        request_id,
                        extension_id: extension_id.clone(),
                        generation,
                    });
                    self.mark_failed(
                        &extension_id,
                        generation,
                        ProtocolFailure {
                            code: "deadline_exceeded".to_owned(),
                            message: "extension command exceeded its host deadline".to_owned(),
                        },
                    )?;
                    Err(ExtensionError::DeadlineExceeded)
                }
            };
        self.record_command(
            &extension_id,
            generation,
            elapsed_milliseconds(command_started),
            outcome.is_err(),
        )?;
        outcome
    }

    pub async fn activate_extensions(
        &self,
        reason: ActivationReason,
    ) -> Result<(), ExtensionError> {
        let event = match &reason {
            ActivationReason::WorkbenchReady => "onWorkbenchReady".to_owned(),
            ActivationReason::Language { language_id } => {
                if language_id.is_empty()
                    || language_id.len() > 64
                    || !language_id.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'+')
                    })
                {
                    return Err(ExtensionError::InvalidRequest(
                        "language activation id is invalid".to_owned(),
                    ));
                }
                format!("onLanguage:{language_id}")
            }
            ActivationReason::Command { .. } => {
                return Err(ExtensionError::InvalidRequest(
                    "command activation is implicit in command execution".to_owned(),
                ));
            }
        };
        let extension_ids =
            lock(&self.service.registry, "extension registry")?.extensions_for_activation(&event);
        let mut failures = Vec::new();
        let activation_slots = Arc::new(Semaphore::new(MAX_CONCURRENT_ACTIVATIONS));
        let mut activations = JoinSet::new();
        for extension_id in extension_ids {
            let state = self.clone();
            let activation_reason = reason.clone();
            let activation_slots = activation_slots.clone();
            activations.spawn(async move {
                let permit = activation_slots.acquire_owned().await.map_err(|_| {
                    ExtensionError::Runtime("extension activation pool is unavailable".to_owned())
                })?;
                let result = state
                    .activate_extension(extension_id.clone(), activation_reason)
                    .await;
                drop(permit);
                Ok::<_, ExtensionError>((extension_id, result))
            });
        }
        while let Some(completed) = activations.join_next().await {
            match completed {
                Ok(Ok((extension_id, Err(error)))) => {
                    failures.push(format!("{extension_id}: {error}"));
                }
                Ok(Ok((_, Ok(())))) => {}
                Ok(Err(error)) => failures.push(error.to_string()),
                Err(error) => failures.push(format!("extension activation task failed: {error}")),
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(ExtensionError::Runtime(format!(
                "extension activation failed: {}",
                failures.join("; ")
            )))
        }
    }

    async fn activate_extension(
        &self,
        extension_id: String,
        activation_reason: ActivationReason,
    ) -> Result<(), ExtensionError> {
        self.require_host_connected()?;
        let (api_version, bundle_sha256, command_ids) = {
            let registry = lock(&self.service.registry, "extension registry")?;
            let installed = registry.active(&extension_id)?;
            (
                installed.active.manifest.api_version,
                installed.active.bundle_sha256.clone(),
                installed
                    .active
                    .manifest
                    .contributes
                    .commands
                    .iter()
                    .map(|command| command.id.clone())
                    .collect::<Vec<_>>(),
            )
        };
        let generation = {
            let mut runtimes = lock(&self.service.runtimes, "extension runtime state")?;
            let diagnostic = runtimes.diagnostic_mut(&extension_id);
            match diagnostic.state {
                ExtensionRuntimeState::Dormant | ExtensionRuntimeState::Stopped => {
                    diagnostic.generation = diagnostic.generation.saturating_add(1);
                    diagnostic.state = ExtensionRuntimeState::Starting;
                    diagnostic.activation_reason = Some(activation_reason.clone());
                    diagnostic.last_error = None;
                }
                ExtensionRuntimeState::Active => return Ok(()),
                ExtensionRuntimeState::Starting | ExtensionRuntimeState::Activating => {}
                ExtensionRuntimeState::Stopping => {
                    return Err(ExtensionError::InvalidRuntimeState(format!(
                        "extension {extension_id} is stopping"
                    )));
                }
                ExtensionRuntimeState::Failed => {
                    return Err(ExtensionError::InvalidRuntimeState(format!(
                        "extension {extension_id} failed and must be restarted explicitly"
                    )));
                }
            }
            diagnostic.generation
        };
        self.publish_snapshot()?;
        let request_id = self.next_request_id();
        let (sender, receiver) = oneshot::channel();
        lock(&self.service.pending, "extension pending requests")?
            .insert(request_id.clone(), sender);
        let instruction = HostInstruction::ActivateExtension {
            protocol_version: EXTENSION_PROTOCOL_VERSION,
            request_id: request_id.clone(),
            extension_id: extension_id.clone(),
            generation,
            api_version,
            bundle_sha256,
            extension_uri: format!("sideral-extension:/{extension_id}/"),
            storage_uri: format!("sideral-storage:/{extension_id}/"),
            command_ids,
            activation_reason,
            start_deadline_milliseconds: WORKER_START_DEADLINE_MILLISECONDS,
            activation_deadline_milliseconds: WORKER_ACTIVATION_DEADLINE_MILLISECONDS,
        };
        if let Err(error) = self.send_to_host(instruction) {
            lock(&self.service.pending, "extension pending requests")?.remove(&request_id);
            self.mark_failed(
                &extension_id,
                generation,
                ProtocolFailure {
                    code: error.code().to_owned(),
                    message: error.to_string(),
                },
            )?;
            return Err(error);
        }
        let deadline = WORKER_START_DEADLINE_MILLISECONDS
            + WORKER_ACTIVATION_DEADLINE_MILLISECONDS
            + HOST_RESPONSE_MARGIN_MILLISECONDS;
        match tokio::time::timeout(std::time::Duration::from_millis(deadline), receiver).await {
            Ok(Ok(result)) => result.map(|_| ()),
            Ok(Err(_)) => Err(ExtensionError::HostUnavailable),
            Err(_) => {
                lock(&self.service.pending, "extension pending requests")?.remove(&request_id);
                self.mark_failed(
                    &extension_id,
                    generation,
                    ProtocolFailure {
                        code: "activation_deadline_exceeded".to_owned(),
                        message: "extension activation exceeded its host deadline".to_owned(),
                    },
                )?;
                Err(ExtensionError::DeadlineExceeded)
            }
        }
    }

    pub fn handle_host_event(
        &self,
        window: &WebviewWindow,
        session_token: &str,
        event: HostEvent,
    ) -> Result<(), ExtensionError> {
        require_window(window, MAIN_WINDOW_LABEL)?;
        self.validate_host_session(session_token)?;
        match event {
            HostEvent::StateChanged {
                protocol_version,
                extension_id,
                generation,
                state,
                activation_reason,
                activation_milliseconds,
                error,
            } => {
                validate_protocol(protocol_version)?;
                validate_optional_protocol_failure(error.as_ref())?;
                let mut runtimes = lock(&self.service.runtimes, "extension runtime state")?;
                let diagnostic = runtimes.diagnostic_mut(&extension_id);
                if diagnostic.generation != generation {
                    return Ok(());
                }
                validate_transition(diagnostic.state, state)?;
                if state == ExtensionRuntimeState::Active
                    && diagnostic.state != ExtensionRuntimeState::Active
                {
                    diagnostic.activation_count = diagnostic.activation_count.saturating_add(1);
                }
                diagnostic.state = state;
                if activation_reason.is_some() {
                    diagnostic.activation_reason = activation_reason;
                }
                if activation_milliseconds.is_some() {
                    diagnostic.last_activation_milliseconds = activation_milliseconds;
                }
                if error.is_some() {
                    diagnostic.last_error = error;
                }
            }
            HostEvent::CommandResult {
                protocol_version,
                request_id,
                extension_id,
                generation,
                result,
                error,
            } => {
                validate_protocol(protocol_version)?;
                validate_broker_request_id(&request_id)?;
                validate_optional_protocol_failure(error.as_ref())?;
                if let Some(result) = result.as_ref() {
                    let result_bytes = serde_json::to_vec(result)
                        .map_err(|serialize_error| {
                            ExtensionError::InvalidRequest(serialize_error.to_string())
                        })?
                        .len();
                    if result_bytes > MAX_COMMAND_RESULT_BYTES {
                        return Err(ExtensionError::InvalidRequest(format!(
                            "command result exceeds {MAX_COMMAND_RESULT_BYTES} bytes"
                        )));
                    }
                }
                if !self.generation_matches(&extension_id, generation)? {
                    return Ok(());
                }
                if let Some(sender) =
                    lock(&self.service.pending, "extension pending requests")?.remove(&request_id)
                {
                    let outcome = match error {
                        Some(error) => Err(ExtensionError::Runtime(format!(
                            "{}: {}",
                            error.code, error.message
                        ))),
                        None => Ok(result),
                    };
                    let _ = sender.send(outcome);
                }
            }
            HostEvent::Activated {
                protocol_version,
                request_id,
                extension_id,
                generation,
                error,
            } => {
                validate_protocol(protocol_version)?;
                validate_broker_request_id(&request_id)?;
                validate_optional_protocol_failure(error.as_ref())?;
                if !self.generation_matches(&extension_id, generation)? {
                    return Ok(());
                }
                let outcome = match error {
                    Some(error) => Err(ExtensionError::Runtime(format!(
                        "{}: {}",
                        error.code, error.message
                    ))),
                    None => Ok(None),
                };
                if let Some(sender) =
                    lock(&self.service.pending, "extension pending requests")?.remove(&request_id)
                {
                    let _ = sender.send(outcome);
                }
            }
            HostEvent::Deactivated {
                protocol_version,
                request_id,
                extension_id,
                generation,
                error,
            } => {
                validate_protocol(protocol_version)?;
                validate_broker_request_id(&request_id)?;
                validate_optional_protocol_failure(error.as_ref())?;
                if !self.generation_matches(&extension_id, generation)? {
                    return Ok(());
                }
                if let Some(error) = error {
                    lock(&self.service.runtimes, "extension runtime state")?
                        .diagnostic_mut(&extension_id)
                        .last_error = Some(error.clone());
                    let _ = self.send_client_instruction(ExtensionClientInstruction::ShowMessage {
                        extension_id: extension_id.clone(),
                        severity: super::protocol::MessageSeverity::Warning,
                        message: format!(
                            "Extension cleanup reported {}: {}",
                            error.code, error.message
                        ),
                    });
                }
                if let Some(sender) =
                    lock(&self.service.pending, "extension pending requests")?.remove(&request_id)
                {
                    let _ = sender.send(Ok(None));
                }
            }
            HostEvent::HostFault {
                protocol_version,
                error,
            } => {
                validate_protocol(protocol_version)?;
                validate_protocol_failure(&error)?;
                self.fail_all_pending(ExtensionError::Runtime(error.message))?;
                lock(&self.service.runtimes, "extension runtime state")?.reset_for_new_host();
                *lock(&self.service.host, "extension host")? = None;
                self.service.broker.cancel_all();
            }
        }
        self.publish_snapshot()
    }

    pub async fn handle_broker_request(
        &self,
        window: &WebviewWindow,
        session_token: &str,
        request: BrokerRequest,
    ) -> Result<BrokerResponse, ExtensionError> {
        require_window(window, MAIN_WINDOW_LABEL)?;
        self.validate_host_session(session_token)?;
        validate_protocol(request.protocol_version)?;
        validate_broker_request_id(&request.request_id)?;
        if !self.generation_matches(&request.extension_id, request.generation)? {
            return Err(ExtensionError::Conflict(format!(
                "stale runtime generation for {}",
                request.extension_id
            )));
        }
        let manifest = lock(&self.service.registry, "extension registry")?
            .active(&request.extension_id)?
            .active
            .manifest
            .clone();
        Ok(self.service.broker.execute(self, &manifest, request).await)
    }

    pub fn cancel_broker_request(
        &self,
        window: &WebviewWindow,
        session_token: &str,
        protocol_version: u16,
        extension_id: &str,
        generation: u64,
        request_id: &str,
    ) -> Result<(), ExtensionError> {
        require_window(window, MAIN_WINDOW_LABEL)?;
        self.validate_host_session(session_token)?;
        validate_protocol(protocol_version)?;
        validate_broker_request_id(request_id)?;
        self.service
            .broker
            .cancel(extension_id, generation, request_id);
        Ok(())
    }

    pub fn load_bundle(
        &self,
        window: &WebviewWindow,
        session_token: &str,
        extension_id: &str,
        generation: u64,
    ) -> Result<Response, ExtensionError> {
        require_window(window, MAIN_WINDOW_LABEL)?;
        self.validate_host_session(session_token)?;
        if !self.generation_matches(extension_id, generation)? {
            return Err(ExtensionError::Conflict(format!(
                "stale runtime generation for {extension_id}"
            )));
        }
        let bundle =
            lock(&self.service.registry, "extension registry")?.load_bundle(extension_id)?;
        Ok(Response::new(bundle))
    }

    pub fn disconnect_host(&self, window: &tauri::Window) {
        if window.label() != MAIN_WINDOW_LABEL {
            return;
        }
        if let Ok(mut host) = self.service.host.lock() {
            *host = None;
        }
        let _ = self.reset_disconnected_host();
    }

    pub fn send_shutdown(&self) {
        self.service.broker.cancel_all();
        let _ = self.send_to_host(HostInstruction::DisposeAll {
            protocol_version: EXTENSION_PROTOCOL_VERSION,
            reason: DeactivationReason::ApplicationShutdown,
            grace_milliseconds: WORKER_SHUTDOWN_GRACE_MILLISECONDS,
        });
    }

    pub fn dismiss_preview(
        &self,
        window: &WebviewWindow,
        resource_id: &str,
    ) -> Result<(), ExtensionError> {
        require_window(window, MAIN_WINDOW_LABEL)?;
        self.service.broker.dismiss_preview(self, resource_id)
    }

    pub fn registry(&self) -> Result<MutexGuard<'_, ExtensionRegistry>, ExtensionError> {
        lock(&self.service.registry, "extension registry")
    }

    pub fn inspect_package(
        &self,
        path: &std::path::Path,
    ) -> Result<PackageInspectionResult, ExtensionError> {
        let registry = self.registry()?;
        let package = registry.inspect_package(path)?;
        let view = registry.package_install_view(&package);
        if registry.publisher_is_trusted(&package.publisher) {
            Ok(PackageInspectionResult::Ready { package: view })
        } else {
            Ok(PackageInspectionResult::PublisherTrustRequired { package: view })
        }
    }

    pub fn install_package(
        &self,
        path: &std::path::Path,
        expected_package_sha256: &str,
        approve_publisher: bool,
    ) -> Result<String, ExtensionError> {
        let extension_id =
            self.registry()?
                .install_package(path, expected_package_sha256, approve_publisher)?;
        Ok(extension_id)
    }

    pub fn update_keybinding_in_registry(
        &self,
        command_id: &str,
        update: super::protocol::KeybindingUpdate,
    ) -> Result<(), ExtensionError> {
        self.registry()?.update_keybinding(command_id, update)
    }

    pub fn preflight_install(
        &self,
        path: &std::path::Path,
        expected_package_sha256: &str,
        approve_publisher: bool,
    ) -> Result<(String, bool), ExtensionError> {
        self.registry()?
            .preflight_install(path, expected_package_sha256, approve_publisher)
    }

    pub fn set_enabled_in_registry(
        &self,
        extension_id: &str,
        enabled: bool,
    ) -> Result<(), ExtensionError> {
        self.registry()?.set_enabled(extension_id, enabled)?;
        if enabled {
            self.reset_runtime(extension_id)?;
        }
        self.publish_snapshot()
    }

    pub fn rollback_registry(&self, extension_id: &str) -> Result<(), ExtensionError> {
        self.registry()?.rollback(extension_id)?;
        self.reset_runtime(extension_id)?;
        self.publish_snapshot()
    }

    pub fn validate_rollback(&self, extension_id: &str) -> Result<(), ExtensionError> {
        self.registry()?.validate_rollback(extension_id)
    }

    pub fn uninstall_from_registry(
        &self,
        extension_id: &str,
    ) -> Result<Vec<std::path::PathBuf>, ExtensionError> {
        let paths = self.registry()?.uninstall(extension_id)?;
        lock(&self.service.runtimes, "extension runtime state")?
            .extensions
            .remove(extension_id);
        self.service.broker.cancel_extension(extension_id);
        self.publish_snapshot()?;
        Ok(paths)
    }

    pub fn reset_runtime(&self, extension_id: &str) -> Result<(), ExtensionError> {
        let mut runtimes = lock(&self.service.runtimes, "extension runtime state")?;
        let diagnostic = runtimes.diagnostic_mut(extension_id);
        diagnostic.state = ExtensionRuntimeState::Dormant;
        diagnostic.generation = diagnostic.generation.saturating_add(1);
        diagnostic.activation_reason = None;
        diagnostic.last_error = None;
        Ok(())
    }

    pub fn publish_snapshot(&self) -> Result<(), ExtensionError> {
        let snapshot = self.snapshot()?;
        self.broadcast_client_instruction(ExtensionClientInstruction::Snapshot { snapshot })?;
        Ok(())
    }

    pub(crate) fn send_client_instruction(
        &self,
        instruction: ExtensionClientInstruction,
    ) -> Result<(), ExtensionError> {
        self.broadcast_client_instruction(instruction)?;
        Ok(())
    }

    fn broadcast_client_instruction(
        &self,
        instruction: ExtensionClientInstruction,
    ) -> Result<(), ExtensionError> {
        lock(&self.service.clients, "extension clients")?
            .retain(|_, channel| channel.send(instruction.clone()).is_ok());
        Ok(())
    }

    pub async fn deactivate_extension(
        &self,
        extension_id: &str,
        reason: DeactivationReason,
    ) -> Result<(), ExtensionError> {
        self.service.broker.cancel_extension(extension_id);
        let generation = {
            let mut runtimes = lock(&self.service.runtimes, "extension runtime state")?;
            let diagnostic = runtimes.diagnostic_mut(extension_id);
            match diagnostic.state {
                ExtensionRuntimeState::Dormant | ExtensionRuntimeState::Stopped => return Ok(()),
                ExtensionRuntimeState::Failed => {
                    diagnostic.state = ExtensionRuntimeState::Dormant;
                    diagnostic.last_error = None;
                    return Ok(());
                }
                ExtensionRuntimeState::Stopping => {
                    return Err(ExtensionError::InvalidRuntimeState(format!(
                        "extension {extension_id} is already stopping"
                    )));
                }
                ExtensionRuntimeState::Starting
                | ExtensionRuntimeState::Activating
                | ExtensionRuntimeState::Active => {
                    diagnostic.state = ExtensionRuntimeState::Stopping;
                    diagnostic.generation
                }
            }
        };
        self.publish_snapshot()?;
        let request_id = self.next_request_id();
        let (sender, receiver) = oneshot::channel();
        lock(&self.service.pending, "extension pending requests")?
            .insert(request_id.clone(), sender);
        if let Err(error) = self.send_to_host(HostInstruction::DeactivateExtension {
            protocol_version: EXTENSION_PROTOCOL_VERSION,
            request_id: request_id.clone(),
            extension_id: extension_id.to_owned(),
            generation,
            reason,
            grace_milliseconds: WORKER_SHUTDOWN_GRACE_MILLISECONDS,
        }) {
            lock(&self.service.pending, "extension pending requests")?.remove(&request_id);
            self.mark_failed(
                extension_id,
                generation,
                ProtocolFailure {
                    code: error.code().to_owned(),
                    message: error.to_string(),
                },
            )?;
            return Err(error);
        }
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(
                WORKER_SHUTDOWN_GRACE_MILLISECONDS + HOST_RESPONSE_MARGIN_MILLISECONDS,
            ),
            receiver,
        )
        .await;
        lock(&self.service.pending, "extension pending requests")?.remove(&request_id);
        match result {
            Ok(Ok(Ok(_))) => {
                let mut runtimes = lock(&self.service.runtimes, "extension runtime state")?;
                let diagnostic = runtimes.diagnostic_mut(extension_id);
                if diagnostic.generation == generation {
                    diagnostic.state = ExtensionRuntimeState::Stopped;
                    diagnostic.generation = diagnostic.generation.saturating_add(1);
                }
                drop(runtimes);
                self.publish_snapshot()?;
                Ok(())
            }
            Ok(Ok(Err(error))) => {
                self.mark_failed(
                    extension_id,
                    generation,
                    ProtocolFailure {
                        code: error.code().to_owned(),
                        message: error.to_string(),
                    },
                )?;
                Err(error)
            }
            Ok(Err(_)) => {
                self.mark_failed(
                    extension_id,
                    generation,
                    ProtocolFailure {
                        code: "extension_host_unavailable".to_owned(),
                        message: "extension host disconnected during deactivation".to_owned(),
                    },
                )?;
                Err(ExtensionError::HostUnavailable)
            }
            Err(_) => {
                self.mark_failed(
                    extension_id,
                    generation,
                    ProtocolFailure {
                        code: "extension_deactivation_deadline".to_owned(),
                        message: "extension did not deactivate before its safety deadline"
                            .to_owned(),
                    },
                )?;
                Err(ExtensionError::DeadlineExceeded)
            }
        }
    }

    fn validate_host_session(&self, session_token: &str) -> Result<(), ExtensionError> {
        let host = lock(&self.service.host, "extension host")?;
        if host
            .as_ref()
            .is_some_and(|connection| connection.session_token == session_token)
        {
            Ok(())
        } else {
            Err(ExtensionError::InvalidHostSession)
        }
    }

    pub fn require_host_connected(&self) -> Result<(), ExtensionError> {
        if lock(&self.service.host, "extension host")?.is_some() {
            Ok(())
        } else {
            Err(ExtensionError::HostUnavailable)
        }
    }

    fn send_to_host(&self, instruction: HostInstruction) -> Result<(), ExtensionError> {
        let host = lock(&self.service.host, "extension host")?;
        host.as_ref()
            .ok_or(ExtensionError::HostUnavailable)?
            .channel
            .send(instruction)
            .map_err(|error| {
                ExtensionError::Runtime(format!("could not contact extension host: {error}"))
            })
    }

    fn generation_matches(
        &self,
        extension_id: &str,
        generation: u64,
    ) -> Result<bool, ExtensionError> {
        let runtimes = lock(&self.service.runtimes, "extension runtime state")?;
        Ok(runtimes
            .extensions
            .get(extension_id)
            .is_some_and(|diagnostic| diagnostic.generation == generation))
    }

    fn mark_failed(
        &self,
        extension_id: &str,
        generation: u64,
        error: ProtocolFailure,
    ) -> Result<(), ExtensionError> {
        let mut runtimes = lock(&self.service.runtimes, "extension runtime state")?;
        let diagnostic = runtimes.diagnostic_mut(extension_id);
        if diagnostic.generation == generation {
            diagnostic.state = ExtensionRuntimeState::Failed;
            diagnostic.last_error = Some(error);
        }
        drop(runtimes);
        self.publish_snapshot()
    }

    fn record_command(
        &self,
        extension_id: &str,
        generation: u64,
        elapsed_milliseconds: u64,
        failed: bool,
    ) -> Result<(), ExtensionError> {
        let mut runtimes = lock(&self.service.runtimes, "extension runtime state")?;
        let diagnostic = runtimes.diagnostic_mut(extension_id);
        if diagnostic.generation == generation {
            diagnostic.command_count = diagnostic.command_count.saturating_add(1);
            diagnostic.last_command_milliseconds = Some(elapsed_milliseconds);
            if failed {
                diagnostic.command_failure_count =
                    diagnostic.command_failure_count.saturating_add(1);
            }
        }
        drop(runtimes);
        self.publish_snapshot()
    }

    fn fail_all_pending(&self, error: ExtensionError) -> Result<(), ExtensionError> {
        let message = error.to_string();
        let mut pending = lock(&self.service.pending, "extension pending requests")?;
        for (_, sender) in pending.drain() {
            let _ = sender.send(Err(ExtensionError::Runtime(message.clone())));
        }
        Ok(())
    }

    fn reset_disconnected_host(&self) -> Result<(), ExtensionError> {
        self.service.broker.cancel_all();
        self.fail_all_pending(ExtensionError::HostUnavailable)?;
        lock(&self.service.runtimes, "extension runtime state")?.reset_for_new_host();
        self.publish_snapshot()
    }

    fn next_request_id(&self) -> String {
        format!(
            "request-{}",
            self.service.next_request_id.fetch_add(1, Ordering::Relaxed)
        )
    }
}

fn require_window(window: &WebviewWindow, expected: &str) -> Result<(), ExtensionError> {
    if window.label() == expected {
        Ok(())
    } else {
        Err(ExtensionError::PermissionDenied(format!(
            "window {} cannot access this extension operation",
            window.label()
        )))
    }
}

fn validate_protocol(protocol_version: u16) -> Result<(), ExtensionError> {
    if protocol_version == EXTENSION_PROTOCOL_VERSION {
        Ok(())
    } else {
        Err(ExtensionError::ProtocolMismatch(protocol_version))
    }
}

fn validate_broker_request_id(request_id: &str) -> Result<(), ExtensionError> {
    if request_id.is_empty()
        || request_id.len() > MAX_BROKER_REQUEST_ID_BYTES
        || !request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(ExtensionError::InvalidRequest(
            "extension broker request id is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn validate_command_id(command_id: &str) -> Result<(), ExtensionError> {
    if command_id.is_empty()
        || command_id.len() > 128
        || command_id.split('.').any(|segment| {
            segment.is_empty()
                || segment.starts_with('-')
                || segment.ends_with('-')
                || !segment
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
    {
        return Err(ExtensionError::InvalidRequest(
            "extension command id is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn validate_active_text_document(document: &TextDocumentView) -> Result<(), ExtensionError> {
    if document.uri.is_empty() || document.uri.len() > 4_096 {
        return Err(ExtensionError::InvalidRequest(
            "active document URI is invalid".to_owned(),
        ));
    }
    let uri = url::Url::parse(&document.uri).map_err(|error| {
        ExtensionError::InvalidRequest(format!("active document URI is invalid: {error}"))
    })?;
    if !matches!(uri.scheme(), "file" | "untitled")
        || !uri.username().is_empty()
        || uri.password().is_some()
        || uri.query().is_some()
        || uri.fragment().is_some()
    {
        return Err(ExtensionError::InvalidRequest(
            "active document must use a clean file or untitled URI".to_owned(),
        ));
    }
    if document.language_id.is_empty()
        || document.language_id.len() > 64
        || !document
            .language_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'+' | b'.'))
    {
        return Err(ExtensionError::InvalidRequest(
            "active document language id is invalid".to_owned(),
        ));
    }
    if document.version == 0 {
        return Err(ExtensionError::InvalidRequest(
            "active document version must be positive".to_owned(),
        ));
    }
    if document.content.len() > MAX_ACTIVE_DOCUMENT_BYTES || document.content.contains('\0') {
        return Err(ExtensionError::InvalidRequest(format!(
            "active document must be UTF-8 text within {MAX_ACTIVE_DOCUMENT_BYTES} bytes"
        )));
    }
    Ok(())
}

fn validate_optional_protocol_failure(
    failure: Option<&ProtocolFailure>,
) -> Result<(), ExtensionError> {
    match failure {
        Some(failure) => validate_protocol_failure(failure),
        None => Ok(()),
    }
}

fn validate_protocol_failure(failure: &ProtocolFailure) -> Result<(), ExtensionError> {
    if failure.code.is_empty()
        || failure.code.len() > 128
        || !failure
            .code
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        || failure.message.is_empty()
        || failure.message.len() > MAX_PROTOCOL_FAILURE_MESSAGE_BYTES
        || failure.message.contains('\0')
    {
        return Err(ExtensionError::InvalidRequest(
            "extension protocol failure is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn validate_transition(
    current: ExtensionRuntimeState,
    next: ExtensionRuntimeState,
) -> Result<(), ExtensionError> {
    let allowed = current == next
        || matches!(
            (current, next),
            (
                ExtensionRuntimeState::Dormant,
                ExtensionRuntimeState::Starting
            ) | (
                ExtensionRuntimeState::Stopped,
                ExtensionRuntimeState::Starting
            ) | (
                ExtensionRuntimeState::Starting,
                ExtensionRuntimeState::Activating
            ) | (
                ExtensionRuntimeState::Activating,
                ExtensionRuntimeState::Active
            ) | (
                ExtensionRuntimeState::Starting,
                ExtensionRuntimeState::Stopping
            ) | (
                ExtensionRuntimeState::Activating,
                ExtensionRuntimeState::Stopping
            ) | (
                ExtensionRuntimeState::Active,
                ExtensionRuntimeState::Stopping
            ) | (
                ExtensionRuntimeState::Stopping,
                ExtensionRuntimeState::Stopped
            ) | (_, ExtensionRuntimeState::Failed)
        );
    if allowed {
        Ok(())
    } else {
        Err(ExtensionError::InvalidRuntimeState(format!(
            "{current:?} cannot transition to {next:?}"
        )))
    }
}

fn lock<'a, T>(
    mutex: &'a Mutex<T>,
    resource: &'static str,
) -> Result<MutexGuard<'a, T>, ExtensionError> {
    mutex
        .lock()
        .map_err(|_| ExtensionError::Runtime(format!("{resource} is unavailable")))
}

fn elapsed_milliseconds(started: std::time::Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}
