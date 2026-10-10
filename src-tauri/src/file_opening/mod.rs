mod launch;
mod queue;

#[cfg(test)]
mod tests;

use std::{ffi::OsString, path::Path, sync::Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewWindow, Window, WindowEvent, ipc::Channel};

use crate::{
    desktop_integration,
    error::{AppError, AppResult, CommandError, CommandResult},
};

use launch::{LaunchFiles, parse_launch};
use queue::{FileOpenQueue, FileOpenRequest};

const MAIN_WINDOW_LABEL: &str = "main";
const MAX_CLIENT_ID_BYTES: usize = 64;

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileOpenInstruction {
    Open { request: FileOpenRequest },
    Failure { error: CommandError },
}

struct Client {
    id: String,
    channel: Channel<FileOpenInstruction>,
}

#[derive(Default)]
struct DeliveryState {
    queue: FileOpenQueue,
    client: Option<Client>,
    pending_failure: Option<CommandError>,
    reveal_requested: bool,
}

#[derive(Default)]
pub struct FileOpeningState {
    delivery: Mutex<DeliveryState>,
}

impl FileOpeningState {
    pub fn from_initial_launch() -> AppResult<Self> {
        let cwd = std::env::current_dir()
            .map_err(|source| AppError::io("could not resolve the launch directory", source))?;
        let launch = parse_launch(std::env::args_os().skip(1), &cwd);
        let state = Self::default();
        state.submit(launch.files, launch.reveal_window)?;
        Ok(state)
    }

    pub fn requires_visible_startup(&self) -> AppResult<bool> {
        let delivery = self.lock()?;
        Ok(delivery.reveal_requested)
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, DeliveryState>> {
        self.delivery
            .lock()
            .map_err(|_| AppError::Runtime("file-opening state is unavailable".to_owned()))
    }

    fn submit(&self, files: LaunchFiles, reveal_window: bool) -> AppResult<()> {
        let mut delivery = self.lock()?;
        delivery.reveal_requested |= reveal_window;
        match delivery.queue.enqueue(files) {
            Ok(Some(request)) => delivery.send(FileOpenInstruction::Open { request }),
            Ok(None) => {}
            Err(error) => {
                delivery.pending_failure = Some(CommandError::from(error));
                delivery.flush_failure();
            }
        }
        Ok(())
    }

    fn connect(&self, id: String, channel: Channel<FileOpenInstruction>) -> AppResult<()> {
        if id.is_empty() || id.len() > MAX_CLIENT_ID_BYTES {
            return Err(AppError::Runtime(
                "invalid file-opening client identifier".to_owned(),
            ));
        }
        let mut delivery = self.lock()?;
        delivery.client = Some(Client { id, channel });
        for request in delivery.queue.requests.clone() {
            delivery.send(FileOpenInstruction::Open { request });
            if delivery.client.is_none() {
                return Err(AppError::Runtime(
                    "could not connect the file-opening channel".to_owned(),
                ));
            }
        }
        delivery.flush_failure();
        Ok(())
    }

    fn disconnect(&self, id: &str) -> AppResult<()> {
        let mut delivery = self.lock()?;
        if delivery
            .client
            .as_ref()
            .is_some_and(|client| client.id == id)
        {
            delivery.client = None;
        }
        Ok(())
    }

    fn acknowledge(&self, client_id: &str, request_id: u32) -> AppResult<()> {
        let mut delivery = self.lock()?;
        if !delivery
            .client
            .as_ref()
            .is_some_and(|client| client.id == client_id)
        {
            return Err(AppError::Runtime(
                "the file-opening client is no longer active".to_owned(),
            ));
        }
        delivery.queue.acknowledge(request_id)
    }
}

impl DeliveryState {
    fn send(&mut self, instruction: FileOpenInstruction) {
        let Some(client) = &self.client else {
            return;
        };
        if let Err(error) = client.channel.send(instruction) {
            self.client = None;
            self.pending_failure = Some(CommandError::from(AppError::Runtime(format!(
                "file-opening delivery failed: {error}"
            ))));
        }
    }

    fn flush_failure(&mut self) {
        let Some(error) = self.pending_failure.take() else {
            return;
        };
        if self.client.is_none() {
            self.pending_failure = Some(error);
            return;
        }
        self.send(FileOpenInstruction::Failure { error });
    }
}

pub fn receive_launch(app: &AppHandle, arguments: Vec<String>, cwd: String) {
    let launch = parse_launch(
        arguments.into_iter().skip(1).map(OsString::from),
        Path::new(&cwd),
    );
    let state = app.state::<FileOpeningState>();
    if let Err(error) = state.submit(launch.files, launch.reveal_window) {
        eprintln!("File launch could not be queued: {error}");
    }
    if launch.reveal_window
        // Setup consumes the latched reveal request if the window is not built yet.
        && app.get_webview_window(MAIN_WINDOW_LABEL).is_some()
        && let Err(error) = desktop_integration::show_main_window(app)
    {
        let mut files = LaunchFiles::default();
        files.errors.push(CommandError::from(error));
        if let Err(error) = state.submit(files, true) {
            eprintln!("File launch window error could not be queued: {error}");
        }
    }
}

fn require_main_window(window: &WebviewWindow) -> AppResult<()> {
    if window.label() != MAIN_WINDOW_LABEL {
        return Err(AppError::Runtime(
            "file opening is restricted to the main window".to_owned(),
        ));
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn connect_file_opening(
    window: WebviewWindow,
    state: State<'_, FileOpeningState>,
    client_id: String,
    channel: Channel<FileOpenInstruction>,
) -> CommandResult<()> {
    require_main_window(&window)?;
    state
        .connect(client_id, channel)
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
pub fn disconnect_file_opening(
    window: WebviewWindow,
    state: State<'_, FileOpeningState>,
    client_id: String,
) -> CommandResult<()> {
    require_main_window(&window)?;
    state.disconnect(&client_id).map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
pub fn acknowledge_file_opening(
    window: WebviewWindow,
    state: State<'_, FileOpeningState>,
    client_id: String,
    request_id: u32,
) -> CommandResult<()> {
    require_main_window(&window)?;
    state
        .acknowledge(&client_id, request_id)
        .map_err(CommandError::from)
}

pub fn handle_window_event(window: &Window, event: &WindowEvent) {
    if window.label() == MAIN_WINDOW_LABEL && matches!(event, WindowEvent::Destroyed) {
        match window.app_handle().state::<FileOpeningState>().lock() {
            Ok(mut delivery) => delivery.client = None,
            Err(error) => eprintln!("File-opening channel could not be released: {error}"),
        }
    }
}
