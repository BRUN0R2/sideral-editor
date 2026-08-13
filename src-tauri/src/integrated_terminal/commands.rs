use tauri::{
    AppHandle, Manager, State, WebviewWindow,
    ipc::{Channel, Response},
};

use super::{
    IntegratedTerminalState, OwnedTerminalCreation,
    contracts::{
        CreateIntegratedTerminalRequest, TerminalEvent, TerminalSessionId, TerminalSessionSnapshot,
    },
};
use crate::error::{AppError, AppResult, CommandResult};

#[tauri::command(rename_all = "camelCase")]
pub async fn create_integrated_terminal(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, IntegratedTerminalState>,
    request: CreateIntegratedTerminalRequest,
    output: Channel<Response>,
    events: Channel<TerminalEvent>,
) -> CommandResult<TerminalSessionSnapshot> {
    let home_directory = app
        .path()
        .home_dir()
        .map_err(|error| AppError::InvalidPath(error.to_string()))?;
    let owner_window = window.label().to_owned();
    let state = state.inner().clone();
    crate::run_blocking(move || {
        state.create(OwnedTerminalCreation {
            columns: request.columns,
            events,
            home_directory,
            output,
            owner_window,
            rows: request.rows,
            workspace_root: request.workspace_root,
        })
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn write_integrated_terminal(
    window: WebviewWindow,
    state: State<'_, IntegratedTerminalState>,
    session_id: TerminalSessionId,
    data: String,
) -> CommandResult<()> {
    let owner_window = window.label().to_owned();
    let state = state.inner().clone();
    crate::run_blocking(move || state.write(&owner_window, &session_id, data)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn resize_integrated_terminal(
    window: WebviewWindow,
    state: State<'_, IntegratedTerminalState>,
    session_id: TerminalSessionId,
    columns: u16,
    rows: u16,
) -> CommandResult<()> {
    let owner_window = window.label().to_owned();
    let state = state.inner().clone();
    crate::run_blocking(move || state.resize(&owner_window, &session_id, columns, rows)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn close_integrated_terminal(
    window: WebviewWindow,
    state: State<'_, IntegratedTerminalState>,
    session_id: TerminalSessionId,
) -> CommandResult<()> {
    let owner_window = window.label().to_owned();
    let state = state.inner().clone();
    crate::run_blocking(move || state.close(&owner_window, &session_id)).await
}

pub fn request_shutdown(app: &AppHandle) -> AppResult<()> {
    let state = app
        .try_state::<IntegratedTerminalState>()
        .ok_or_else(|| AppError::Terminal("integrated terminal state is unavailable".to_owned()))?;
    state.shutdown_all()
}
