use serde::{Deserialize, Serialize};
use serde_json::Value;
use sideral_extension_core::{
    CommandContribution, CommandDocumentSync, CommandInvocation, ConfigurationContribution,
    KeybindingContribution, LanguageContribution, PermissionSet, WorkspaceAccess,
};

pub const EXTENSION_PROTOCOL_VERSION: u16 = 3;
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
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
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
    pub invocation: CommandInvocation,
    pub document_sync: CommandDocumentSync,
    pub extension_id: String,
}

impl ExtensionCommandView {
    pub fn from_contribution(extension_id: &str, command: &CommandContribution) -> Self {
        Self {
            id: command.id.clone(),
            title: command.title.clone(),
            category: command.category.clone(),
            invocation: command.invocation,
            document_sync: command.document_sync,
            extension_id: extension_id.to_owned(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionLanguageView {
    pub extension_id: String,
    pub id: String,
    pub aliases: Vec<String>,
    pub extensions: Vec<String>,
}

impl ExtensionLanguageView {
    pub fn from_contribution(extension_id: &str, language: &LanguageContribution) -> Self {
        Self {
            extension_id: extension_id.to_owned(),
            id: language.id.clone(),
            aliases: language.aliases.clone(),
            extensions: language.extensions.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionKeybindingView {
    pub extension_id: String,
    pub command_id: String,
    pub command_title: String,
    pub default_key: String,
    pub key: Option<String>,
    pub languages: Vec<String>,
    pub user_defined: bool,
    pub conflict: bool,
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
    pub keybindings: Vec<ExtensionKeybindingView>,
    pub languages: Vec<ExtensionLanguageView>,
    pub configuration: Option<ConfigurationContribution>,
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
    pub keybindings: Vec<ExtensionKeybindingView>,
    pub languages: Vec<ExtensionLanguageView>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientHandshake {
    pub connection_id: u64,
    pub snapshot: ExtensionSnapshot,
    pub outputs: Vec<OutputChannelView>,
    pub previews: Vec<PreviewDocumentView>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostHandshake {
    pub protocol_version: u16,
    pub supported_api_versions: Vec<u16>,
    pub session_id: u64,
    pub session_token: String,
    pub shutdown_grace_milliseconds: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
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
        workspace_access: WorkspaceAccess,
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
        workspace_access: WorkspaceAccess,
        command_id: String,
        arguments: Vec<Value>,
        active_text_document: Option<TextDocumentView>,
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
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
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
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
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
    PreviewChanged {
        preview: Box<PreviewDocumentView>,
    },
    PreviewDisposed {
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
    pub reveal_sequence: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PreviewFormat {
    Markdown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewScrollbarAppearance {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track_size: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumb_size: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumb_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumb_hover_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumb_active_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_buttons: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button_size: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arrow_size: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arrow_height: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arrow_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arrow_hover_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arrow_active_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corner_radius: Option<u16>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewAppearance {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scrollbar: Option<PreviewScrollbarAppearance>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewDocumentView {
    pub resource_id: String,
    pub extension_id: String,
    pub title: String,
    pub format: PreviewFormat,
    pub content: String,
    pub source_uri: Option<String>,
    pub appearance: Option<PreviewAppearance>,
    pub visible: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextDocumentView {
    pub uri: String,
    pub language_id: String,
    pub version: u64,
    pub content: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum KeybindingUpdate {
    Default,
    Disabled,
    Custom { key: String },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionConfigurationView {
    pub extension_id: String,
    pub title: String,
    pub properties: Vec<ExtensionConfigurationPropertyView>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExtensionConfigurationPropertyView {
    Executable {
        key: String,
        title: String,
        description: Option<String>,
        default_value: String,
        value: String,
        user_defined: bool,
    },
    Text {
        key: String,
        title: String,
        description: Option<String>,
        placeholder: Option<String>,
        default_value: String,
        value: String,
        user_defined: bool,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ConfigurationUpdate {
    Default,
    Value { value: String },
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
    #[serde(rename = "discordPresence.clearActivity")]
    DiscordPresenceClearActivity,
    #[serde(rename = "discordPresence.setActivity")]
    DiscordPresenceSetActivity,
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
    #[serde(rename = "window.preview.create")]
    WindowPreviewCreate,
    #[serde(rename = "window.preview.dispose")]
    WindowPreviewDispose,
    #[serde(rename = "window.preview.hide")]
    WindowPreviewHide,
    #[serde(rename = "window.preview.show")]
    WindowPreviewShow,
    #[serde(rename = "window.preview.toggle")]
    WindowPreviewToggle,
    #[serde(rename = "window.preview.update")]
    WindowPreviewUpdate,
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
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
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
    pub keybindings: Vec<KeybindingContribution>,
    pub languages: Vec<LanguageContribution>,
    pub configuration: Option<ConfigurationContribution>,
    pub replaces_version: Option<String>,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        ActivationReason, EXTENSION_PROTOCOL_VERSION, ExtensionClientInstruction, HostEvent,
        HostInstruction, OutputChannelView, PreviewAppearance, PreviewDocumentView, PreviewFormat,
        PreviewScrollbarAppearance,
    };

    #[test]
    fn activation_reason_round_trips_camel_case_variant_fields() {
        let reason = ActivationReason::Language {
            language_id: "typescript".to_owned(),
        };
        let wire_value = json!({
            "kind": "language",
            "languageId": "typescript",
        });

        assert_eq!(serde_json::to_value(&reason).ok(), Some(wire_value.clone()));
        assert_eq!(
            serde_json::from_value::<ActivationReason>(wire_value).ok(),
            Some(reason),
        );
    }

    #[test]
    fn host_instruction_serializes_camel_case_variant_fields() {
        let instruction = HostInstruction::CancelRequest {
            protocol_version: EXTENSION_PROTOCOL_VERSION,
            request_id: "request-1".to_owned(),
            extension_id: "acme.sample".to_owned(),
            generation: 3,
        };

        assert_eq!(
            serde_json::to_value(instruction).ok(),
            Some(json!({
                "kind": "cancelRequest",
                "protocolVersion": EXTENSION_PROTOCOL_VERSION,
                "requestId": "request-1",
                "extensionId": "acme.sample",
                "generation": 3,
            })),
        );
    }

    #[test]
    fn host_event_deserializes_camel_case_variant_fields() {
        let event = serde_json::from_value::<HostEvent>(json!({
            "kind": "activated",
            "protocolVersion": EXTENSION_PROTOCOL_VERSION,
            "requestId": "request-2",
            "extensionId": "acme.sample",
            "generation": 4,
            "error": null,
        }));

        assert!(matches!(
            event,
            Ok(HostEvent::Activated {
                protocol_version: EXTENSION_PROTOCOL_VERSION,
                request_id,
                extension_id,
                generation: 4,
                error: None,
            }) if request_id == "request-2" && extension_id == "acme.sample"
        ));
    }

    #[test]
    fn client_instruction_serializes_camel_case_variant_fields() {
        let instruction = ExtensionClientInstruction::OutputDisposed {
            resource_id: "output-1".to_owned(),
        };

        assert_eq!(
            serde_json::to_value(instruction).ok(),
            Some(json!({
                "kind": "outputDisposed",
                "resourceId": "output-1",
            })),
        );
    }

    #[test]
    fn output_instruction_serializes_reveal_sequence() {
        let instruction = ExtensionClientInstruction::OutputChanged {
            channel: OutputChannelView {
                resource_id: "acme.compiler:1".to_owned(),
                extension_id: "acme.compiler".to_owned(),
                name: "Compiler".to_owned(),
                content: "Compiling...\n".to_owned(),
                reveal_sequence: 2,
            },
        };

        assert_eq!(
            serde_json::to_value(instruction).ok(),
            Some(json!({
                "kind": "outputChanged",
                "channel": {
                    "resourceId": "acme.compiler:1",
                    "extensionId": "acme.compiler",
                    "name": "Compiler",
                    "content": "Compiling...\n",
                    "revealSequence": 2,
                },
            })),
        );
    }

    #[test]
    fn preview_instruction_serializes_a_safe_typed_document() {
        let instruction = ExtensionClientInstruction::PreviewChanged {
            preview: Box::new(PreviewDocumentView {
                resource_id: "preview:sample:1".to_owned(),
                extension_id: "sample.extension".to_owned(),
                title: "README preview".to_owned(),
                format: PreviewFormat::Markdown,
                content: "# README".to_owned(),
                source_uri: Some("file:///D:/workspace/README.md".to_owned()),
                appearance: Some(PreviewAppearance {
                    scrollbar: Some(PreviewScrollbarAppearance {
                        track_size: Some(16),
                        thumb_size: Some(10),
                        track_color: Some("transparent".to_owned()),
                        thumb_color: Some("#8b5cf6".to_owned()),
                        thumb_hover_color: None,
                        thumb_active_color: None,
                        show_buttons: Some(true),
                        button_size: Some(16),
                        arrow_size: Some(11),
                        arrow_height: Some(6),
                        arrow_color: Some("#69717d".to_owned()),
                        arrow_hover_color: None,
                        arrow_active_color: None,
                        corner_radius: Some(12),
                    }),
                }),
                visible: true,
            }),
        };

        assert_eq!(
            serde_json::to_value(instruction).ok(),
            Some(json!({
                "kind": "previewChanged",
                "preview": {
                    "resourceId": "preview:sample:1",
                    "extensionId": "sample.extension",
                    "title": "README preview",
                    "format": "markdown",
                    "content": "# README",
                    "sourceUri": "file:///D:/workspace/README.md",
                    "appearance": {
                        "scrollbar": {
                            "trackSize": 16,
                            "thumbSize": 10,
                            "trackColor": "transparent",
                            "thumbColor": "#8b5cf6",
                            "showButtons": true,
                            "buttonSize": 16,
                            "arrowSize": 11,
                            "arrowHeight": 6,
                            "arrowColor": "#69717d",
                            "cornerRadius": 12,
                        }
                    },
                    "visible": true,
                },
            })),
        );
    }
}
