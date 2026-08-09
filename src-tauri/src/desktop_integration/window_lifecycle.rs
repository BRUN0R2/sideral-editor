use tauri::{Manager, WebviewWindow, Window, WindowEvent};

use crate::{
    desktop_integration::{DesktopPreferencesState, startup},
    error::{AppError, AppResult},
};

const MAIN_WINDOW_LABEL: &str = "main";

pub fn apply_initial_window_state(window: &WebviewWindow) -> AppResult<()> {
    let preferences = window
        .app_handle()
        .state::<DesktopPreferencesState>()
        .current()?;
    let should_start_hidden = preferences.start_minimized && startup::is_minimized_launch();

    if should_start_hidden {
        window.hide().map_err(runtime_error)?;
        return Ok(());
    }

    window.show().map_err(runtime_error)?;
    window.unminimize().map_err(runtime_error)?;
    window.set_focus().map_err(runtime_error)?;
    Ok(())
}

pub fn handle_main_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW_LABEL {
        return;
    }

    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };

    let preferences = window
        .app_handle()
        .state::<DesktopPreferencesState>()
        .current();

    match preferences {
        Ok(preferences) if preferences.close_to_tray => {
            api.prevent_close();
            if let Err(error) = window.hide() {
                eprintln!("Main window could not move to tray: {error}");
                window.app_handle().exit(1);
            }
        }
        Ok(_) => window.app_handle().exit(0),
        Err(error) => {
            eprintln!("Main window close policy is unavailable: {error}");
            window.app_handle().exit(1);
        }
    }
}

fn runtime_error(error: tauri::Error) -> AppError {
    AppError::Runtime(error.to_string())
}
