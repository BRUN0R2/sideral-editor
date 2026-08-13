mod broker;
mod error;
mod protocol;
mod registry;
mod service;

use std::path::PathBuf;

use serde_json::Value;
use tauri::{
    AppHandle, Manager, State, WebviewWindow, Window, WindowEvent,
    ipc::{Channel, Response},
};

pub use error::{ExtensionCommandError, ExtensionError};
pub use protocol::{
    BrokerRequest, BrokerResponse, ClientHandshake, ExtensionClientInstruction, ExtensionSnapshot,
    HostEvent, HostHandshake, HostInstruction, PackageInspectionResult,
};
pub use service::SideralExtensionState;

use protocol::{ActivationReason, DeactivationReason, KeybindingUpdate, TextDocumentView};
use registry::remove_installed_packages;

pub type ExtensionCommandResult<T> = Result<T, ExtensionCommandError>;

#[tauri::command]
pub fn initialize_extension_system(
    window: WebviewWindow,
    state: State<'_, SideralExtensionState>,
) -> ExtensionCommandResult<ExtensionSnapshot> {
    state
        .require_main_window(&window)
        .map_err(ExtensionCommandError::from)?;
    state
        .require_host_connected()
        .map_err(ExtensionCommandError::from)?;
    state.snapshot().map_err(ExtensionCommandError::from)
}

#[tauri::command]
pub fn connect_extension_client(
    window: WebviewWindow,
    state: State<'_, SideralExtensionState>,
    channel: Channel<ExtensionClientInstruction>,
) -> ExtensionCommandResult<ClientHandshake> {
    state
        .connect_client(&window, channel)
        .map_err(ExtensionCommandError::from)
}

#[tauri::command]
pub fn disconnect_extension_client(
    window: WebviewWindow,
    state: State<'_, SideralExtensionState>,
    connection_id: u64,
) -> ExtensionCommandResult<()> {
    state
        .disconnect_client(&window, connection_id)
        .map_err(ExtensionCommandError::from)
}

#[tauri::command]
pub fn connect_extension_host(
    window: WebviewWindow,
    state: State<'_, SideralExtensionState>,
    channel: Channel<HostInstruction>,
) -> ExtensionCommandResult<HostHandshake> {
    state
        .connect_host(&window, channel)
        .map_err(ExtensionCommandError::from)
}

#[tauri::command]
pub fn disconnect_extension_host(
    window: WebviewWindow,
    state: State<'_, SideralExtensionState>,
    session_id: u64,
) -> ExtensionCommandResult<()> {
    state
        .disconnect_host_session(&window, session_id)
        .map_err(ExtensionCommandError::from)
}

#[tauri::command]
pub async fn execute_extension_command(
    window: WebviewWindow,
    state: State<'_, SideralExtensionState>,
    command_id: String,
    #[allow(clippy::needless_pass_by_value)] arguments: Vec<Value>,
    active_text_document: Option<TextDocumentView>,
) -> ExtensionCommandResult<Option<Value>> {
    state
        .require_main_window(&window)
        .map_err(ExtensionCommandError::from)?;
    state
        .execute_command(command_id, arguments, active_text_document)
        .await
        .map_err(ExtensionCommandError::from)
}

#[tauri::command]
pub async fn activate_extension_event(
    window: WebviewWindow,
    state: State<'_, SideralExtensionState>,
    reason: ActivationReason,
) -> ExtensionCommandResult<()> {
    state
        .require_main_window(&window)
        .map_err(ExtensionCommandError::from)?;
    state
        .activate_extensions(reason)
        .await
        .map_err(ExtensionCommandError::from)
}

#[tauri::command]
pub async fn extension_broker_request(
    window: WebviewWindow,
    state: State<'_, SideralExtensionState>,
    session_token: String,
    request: BrokerRequest,
) -> ExtensionCommandResult<BrokerResponse> {
    state
        .handle_broker_request(&window, &session_token, request)
        .await
        .map_err(ExtensionCommandError::from)
}

#[tauri::command]
pub fn cancel_extension_broker_request(
    window: WebviewWindow,
    state: State<'_, SideralExtensionState>,
    session_token: String,
    protocol_version: u16,
    extension_id: String,
    generation: u64,
    request_id: String,
) -> ExtensionCommandResult<()> {
    state
        .cancel_broker_request(
            &window,
            &session_token,
            protocol_version,
            &extension_id,
            generation,
            &request_id,
        )
        .map_err(ExtensionCommandError::from)
}

#[tauri::command]
pub async fn set_extension_workspace(
    window: WebviewWindow,
    state: State<'_, SideralExtensionState>,
    root: Option<String>,
) -> ExtensionCommandResult<()> {
    let state = state.inner().clone();
    spawn_extension_blocking(move || state.set_workspace_root(&window, root.map(PathBuf::from)))
        .await
}

#[tauri::command]
pub fn dismiss_extension_preview(
    window: WebviewWindow,
    state: State<'_, SideralExtensionState>,
    resource_id: String,
    expected_source_uri: Option<String>,
) -> ExtensionCommandResult<()> {
    state
        .dismiss_preview(&window, &resource_id, expected_source_uri.as_deref())
        .map_err(ExtensionCommandError::from)
}

#[tauri::command]
pub async fn update_extension_keybinding(
    window: WebviewWindow,
    state: State<'_, SideralExtensionState>,
    command_id: String,
    update: KeybindingUpdate,
) -> ExtensionCommandResult<ExtensionSnapshot> {
    let state = state.inner().clone();
    state
        .require_main_window(&window)
        .map_err(ExtensionCommandError::from)?;
    let _mutation_guard = state.lock_mutations().await;
    let operation_state = state.clone();
    spawn_extension_blocking(move || {
        operation_state.update_keybinding_in_registry(&command_id, update)
    })
    .await?;
    state
        .publish_snapshot()
        .map_err(ExtensionCommandError::from)?;
    state.snapshot().map_err(ExtensionCommandError::from)
}

#[tauri::command]
pub fn extension_host_event(
    window: WebviewWindow,
    state: State<'_, SideralExtensionState>,
    session_token: String,
    event: HostEvent,
) -> ExtensionCommandResult<()> {
    state
        .handle_host_event(&window, &session_token, event)
        .map_err(ExtensionCommandError::from)
}

#[tauri::command]
pub async fn extension_host_bundle(
    window: WebviewWindow,
    state: State<'_, SideralExtensionState>,
    session_token: String,
    extension_id: String,
    generation: u64,
) -> ExtensionCommandResult<Response> {
    let state = state.inner().clone();
    spawn_extension_blocking(move || {
        state.load_bundle(&window, &session_token, &extension_id, generation)
    })
    .await
}

#[tauri::command]
pub async fn inspect_extension_package(
    window: WebviewWindow,
    state: State<'_, SideralExtensionState>,
    path: String,
) -> ExtensionCommandResult<PackageInspectionResult> {
    let state = state.inner().clone();
    spawn_extension_blocking(move || {
        state.require_main_window(&window)?;
        state.inspect_package(&PathBuf::from(path))
    })
    .await
}

#[tauri::command]
pub async fn install_extension_package(
    window: WebviewWindow,
    state: State<'_, SideralExtensionState>,
    path: String,
    expected_package_sha256: String,
    approve_publisher: bool,
) -> ExtensionCommandResult<ExtensionSnapshot> {
    let state = state.inner().clone();
    state
        .require_main_window(&window)
        .map_err(ExtensionCommandError::from)?;
    let _mutation_guard = state.lock_mutations().await;
    let package_path = PathBuf::from(path);
    let preflight_state = state.clone();
    let preflight_path = package_path.clone();
    let preflight_hash = expected_package_sha256.clone();
    let (extension_id, already_installed) = spawn_extension_blocking(move || {
        preflight_state.preflight_install(&preflight_path, &preflight_hash, approve_publisher)
    })
    .await?;
    if !already_installed {
        state
            .deactivate_extension(&extension_id, DeactivationReason::Reload)
            .await
            .map_err(ExtensionCommandError::from)?;
    }
    let install_state = state.clone();
    spawn_extension_blocking(move || {
        install_state.install_package(&package_path, &expected_package_sha256, approve_publisher)
    })
    .await?;
    if !already_installed {
        state
            .reset_runtime(&extension_id)
            .map_err(ExtensionCommandError::from)?;
    }
    state
        .publish_snapshot()
        .map_err(ExtensionCommandError::from)?;
    state.snapshot().map_err(ExtensionCommandError::from)
}

#[tauri::command]
pub async fn set_extension_enabled(
    window: WebviewWindow,
    state: State<'_, SideralExtensionState>,
    extension_id: String,
    enabled: bool,
) -> ExtensionCommandResult<ExtensionSnapshot> {
    let state = state.inner().clone();
    state
        .require_main_window(&window)
        .map_err(ExtensionCommandError::from)?;
    let _mutation_guard = state.lock_mutations().await;
    if !enabled {
        state
            .deactivate_extension(&extension_id, DeactivationReason::Disabled)
            .await
            .map_err(ExtensionCommandError::from)?;
    }
    let operation_state = state.clone();
    let operation_id = extension_id;
    spawn_extension_blocking(move || {
        operation_state.set_enabled_in_registry(&operation_id, enabled)
    })
    .await?;
    state.snapshot().map_err(ExtensionCommandError::from)
}

#[tauri::command]
pub async fn restart_extension(
    window: WebviewWindow,
    state: State<'_, SideralExtensionState>,
    extension_id: String,
) -> ExtensionCommandResult<ExtensionSnapshot> {
    let state = state.inner().clone();
    state
        .require_main_window(&window)
        .map_err(ExtensionCommandError::from)?;
    let _mutation_guard = state.lock_mutations().await;
    state
        .deactivate_extension(&extension_id, DeactivationReason::Reload)
        .await
        .map_err(ExtensionCommandError::from)?;
    state
        .reset_runtime(&extension_id)
        .map_err(ExtensionCommandError::from)?;
    state.snapshot().map_err(ExtensionCommandError::from)
}

#[tauri::command]
pub async fn rollback_extension(
    window: WebviewWindow,
    state: State<'_, SideralExtensionState>,
    extension_id: String,
) -> ExtensionCommandResult<ExtensionSnapshot> {
    let state = state.inner().clone();
    state
        .require_main_window(&window)
        .map_err(ExtensionCommandError::from)?;
    let _mutation_guard = state.lock_mutations().await;
    let validation_state = state.clone();
    let validation_id = extension_id.clone();
    spawn_extension_blocking(move || validation_state.validate_rollback(&validation_id)).await?;
    state
        .deactivate_extension(&extension_id, DeactivationReason::Reload)
        .await
        .map_err(ExtensionCommandError::from)?;
    let operation_state = state.clone();
    let operation_id = extension_id.clone();
    spawn_extension_blocking(move || operation_state.rollback_registry(&operation_id)).await?;
    state.snapshot().map_err(ExtensionCommandError::from)
}

#[tauri::command]
pub async fn uninstall_extension(
    window: WebviewWindow,
    state: State<'_, SideralExtensionState>,
    extension_id: String,
) -> ExtensionCommandResult<ExtensionSnapshot> {
    let state = state.inner().clone();
    state
        .require_main_window(&window)
        .map_err(ExtensionCommandError::from)?;
    let _mutation_guard = state.lock_mutations().await;
    state
        .deactivate_extension(&extension_id, DeactivationReason::Disabled)
        .await
        .map_err(ExtensionCommandError::from)?;
    let operation_state = state.clone();
    let operation_id = extension_id;
    spawn_extension_blocking(move || {
        let paths = operation_state.uninstall_from_registry(&operation_id)?;
        remove_installed_packages(paths)
    })
    .await?;
    state.snapshot().map_err(ExtensionCommandError::from)
}

pub fn handle_window_event(window: &Window, event: &WindowEvent) {
    if !matches!(event, WindowEvent::Destroyed) {
        return;
    }
    if let Some(state) = window.app_handle().try_state::<SideralExtensionState>()
        && let Err(error) = state.disconnect_host(window)
    {
        eprintln!("Extension host disconnection failed: {error}");
    }
}

pub fn request_shutdown(app: &AppHandle) -> Result<(), ExtensionError> {
    if let Some(state) = app.try_state::<SideralExtensionState>() {
        state.send_shutdown()?;
    }
    Ok(())
}

async fn spawn_extension_blocking<T, Operation>(operation: Operation) -> ExtensionCommandResult<T>
where
    T: Send + 'static,
    Operation: FnOnce() -> Result<T, ExtensionError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| ExtensionCommandError::from(ExtensionError::Runtime(error.to_string())))?
        .map_err(ExtensionCommandError::from)
}
