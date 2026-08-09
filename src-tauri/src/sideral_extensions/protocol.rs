use serde::{Deserialize, Serialize};
use serde_json::Value;
use sideral_extension_core::{CommandContribution, PermissionSet};

pub const EXTENSION_PROTOCOL_VERSION: u16 = 1;
pub const WORKER_START_DEADLINE_MILLISECONDS: u64 = 5_000;
pub const WORKER_ACTIVATION_DEADLINE_MILLISECONDS: u64 = 10_000;
pub const COMMAND_EXECUTION_DEADLINE_MILLISECONDS: u64 = 30_000;
pub const WORKER_SHUTDOWN_GRACE_MILLISECONDS: u64 = 2_000;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionRuntimeState {
    #[default]
    Dormant,
    Starting,
    Activating,
    Active,
    Stopping,
    Stopped,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ActivationReason {
    Command { command_id: String },
    Language { language_id: String },
    WorkbenchReady,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtocolFailure {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDiagnostic {
    pub state: ExtensionRuntimeState,
    pub generation: u64,
    pub activation_reason: Option<ActivationReason>,
    pub last_activation_milliseconds: Option<u64>,
    pub activation_count: u64,
    pub command_count: u64,
    pub command_failure_count: u64,
    pub last_command_milliseconds: Option<u64>,
    pub last_error: Option<ProtocolFailure>,
}

impl Default for RuntimeDiagnostic {
    fn default() -> Self {
        Self {
            state: ExtensionRuntimeState::Dormant,
            generation: 0,
            activation_reason: None,
            last_activation_milliseconds: None,
            activation_count: 0,
            command_count: 0,
            command_failure_count: 0,
            last_command_milliseconds: None,
            last_error: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionCommandView {
    pub id: String,
    pub title: String,
    pub category: Option<String>,
    pub extension_id: String,
}

impl ExtensionCommandView {
    pub fn from_contribution(extension_id: &str, command: &CommandContribution) -> Self {
        Self {
            id: command.id.clone(),
            title: command.title.clone(),
            category: command.category.clone(),
            extension_id: extension_id.to_owned(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledExtensionView {
    pub id: String,
    pub display_name: String,
    pub version: String,
    pub description: Option<String>,
    pub enabled: bool,
    pub development: bool,
    pub publisher: String,
    pub permissions: PermissionSet,
    pub activation_events: Vec<String>,
    pub commands: Vec<ExtensionCommandView>,
    pub runtime: RuntimeDiagnostic,
    pub rollback_version: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionSnapshot {
    pub sequence: u64,
    pub revision: u64,
    pub extensions: Vec<InstalledExtensionView>,
    pub commands: Vec<ExtensionCommandView>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientHandshake {
    pub connection_id: u64,
    pub snapshot: ExtensionSnapshot,
    pub outputs: Vec<OutputChannelView>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostHandshake {
    pub protocol_version: u16,
    pub supported_api_versions: Vec<u16>,
    pub session_id: u64,
    pub session_token: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HostInstruction {
    ActivateExtension {
        protocol_version: u16,
        request_id: String,
        extension_id: String,
        generation: u64,
        api_version: u16,
        bundle_sha256: String,
        extension_uri: String,
        storage_uri: String,
        command_ids: Vec<String>,
        activation_reason: ActivationReason,
        start_deadline_milliseconds: u64,
        activation_deadline_milliseconds: u64,
    },
    ExecuteCommand {
        protocol_version: u16,
        request_id: String,
        extension_id: String,
        generation: u64,
        api_version: u16,
        bundle_sha256: String,
        extension_uri: String,
        storage_uri: String,
        command_ids: Vec<String>,
        command_id: String,
        arguments: Vec<Value>,
        activation_reason: ActivationReason,
        start_deadline_milliseconds: u64,
        activation_deadline_milliseconds: u64,
        execution_deadline_milliseconds: u64,
    },
    CancelRequest {
        protocol_version: u16,
        request_id: String,
        extension_id: String,
        generation: u64,
    },
    DeactivateExtension {
        protocol_version: u16,
        request_id: String,
        extension_id: String,
        generation: u64,
        reason: DeactivationReason,
        grace_milliseconds: u64,
    },
    DisposeAll {
        protocol_version: u16,
        reason: DeactivationReason,
        grace_milliseconds: u64,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DeactivationReason {
    ApplicationShutdown,
    Disabled,
    Reload,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum HostEvent {
    StateChanged {
        protocol_version: u16,
        extension_id: String,
        generation: u64,
        state: ExtensionRuntimeState,
        activation_reason: Option<ActivationReason>,
        activation_milliseconds: Option<u64>,
        error: Option<ProtocolFailure>,
    },
    CommandResult {
        protocol_version: u16,
        request_id: String,
        extension_id: String,
        generation: u64,
        result: Option<Value>,
        error: Option<ProtocolFailure>,
    },
    Activated {
        protocol_version: u16,
        request_id: String,
        extension_id: String,
        generation: u64,
        error: Option<ProtocolFailure>,
    },
    Deactivated {
        protocol_version: u16,
        request_id: String,
        extension_id: String,
        generation: u64,
        error: Option<ProtocolFailure>,
    },
    HostFault {
        protocol_version: u16,
        error: ProtocolFailure,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExtensionClientInstruction {
    Snapshot {
        snapshot: ExtensionSnapshot,
    },
    ShowMessage {
        extension_id: String,
        severity: MessageSeverity,
        message: String,
    },
    OutputChanged {
        channel: OutputChannelView,
    },
    OutputDisposed {
        resource_id: String,
    },
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MessageSeverity {
    Information,
    Warning,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputChannelView {
    pub resource_id: String,
    pub extension_id: String,
    pub name: String,
    pub content: String,
    pub visible: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrokerRequest {
    pub protocol_version: u16,
    pub extension_id: String,
    pub generation: u64,
    pub request_id: String,
    pub method: BrokerMethod,
    pub payload: serde_json::Map<String, Value>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
pub enum BrokerMethod {
    #[serde(rename = "commands.execute")]
    CommandsExecute,
    #[serde(rename = "configuration.get")]
    ConfigurationGet,
    #[serde(rename = "configuration.update")]
    ConfigurationUpdate,
    #[serde(rename = "network.request")]
    NetworkRequest,
    #[serde(rename = "processes.execute")]
    ProcessesExecute,
    #[serde(rename = "storage.delete")]
    StorageDelete,
    #[serde(rename = "storage.get")]
    StorageGet,
    #[serde(rename = "storage.keys")]
    StorageKeys,
    #[serde(rename = "storage.update")]
    StorageUpdate,
    #[serde(rename = "window.output.append")]
    WindowOutputAppend,
    #[serde(rename = "window.output.clear")]
    WindowOutputClear,
    #[serde(rename = "window.output.create")]
    WindowOutputCreate,
    #[serde(rename = "window.output.dispose")]
    WindowOutputDispose,
    #[serde(rename = "window.output.flush")]
    WindowOutputFlush,
    #[serde(rename = "window.output.show")]
    WindowOutputShow,
    #[serde(rename = "window.showErrorMessage")]
    WindowShowErrorMessage,
    #[serde(rename = "window.showInformationMessage")]
    WindowShowInformationMessage,
    #[serde(rename = "window.showWarningMessage")]
    WindowShowWarningMessage,
    #[serde(rename = "workspace.findFiles")]
    WorkspaceFindFiles,
    #[serde(rename = "workspace.readTextDocument")]
    WorkspaceReadTextDocument,
    #[serde(rename = "workspace.writeTextDocument")]
    WorkspaceWriteTextDocument,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerResponse {
    pub request_id: String,
    pub result: Option<Value>,
    pub error: Option<ProtocolFailure>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum PackageInspectionResult {
    Ready { package: PackageInstallView },
    PublisherTrustRequired { package: PackageInstallView },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInstallView {
    pub id: String,
    pub display_name: String,
    pub version: String,
    pub description: Option<String>,
    pub publisher: String,
    pub key_id: String,
    pub public_key: String,
    pub package_sha256: String,
    pub bundle_sha256: String,
    pub permissions: PermissionSet,
    pub activation_events: Vec<String>,
    pub commands: Vec<CommandContribution>,
    pub replaces_version: Option<String>,
}
