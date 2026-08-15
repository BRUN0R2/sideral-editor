#[cfg(windows)]
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};

#[cfg(windows)]
use tauri::ipc::{Channel, InvokeResponseBody, Response};

use super::contracts::{
    MAX_TERMINAL_COLUMNS, MAX_TERMINAL_ROWS, MIN_TERMINAL_COLUMNS, MIN_TERMINAL_ROWS,
    TerminalSessionId, validate_terminal_size,
};
#[cfg(windows)]
use super::{
    IntegratedTerminalState, OwnedTerminalCreation, TerminalEvent,
    session::{TerminalSession, TerminalSpawnRequest},
    shell::{ShellCandidate, ShellProfile},
};
#[cfg(windows)]
use crate::error::{AppError, AppResult};

#[test]
fn accepts_boundary_terminal_sizes() {
    assert!(validate_terminal_size(MIN_TERMINAL_COLUMNS, MIN_TERMINAL_ROWS).is_ok());
    assert!(validate_terminal_size(MAX_TERMINAL_COLUMNS, MAX_TERMINAL_ROWS).is_ok());
}

#[test]
fn rejects_terminal_sizes_outside_the_contract() {
    assert!(validate_terminal_size(MIN_TERMINAL_COLUMNS - 1, MIN_TERMINAL_ROWS).is_err());
    assert!(validate_terminal_size(MIN_TERMINAL_COLUMNS, MAX_TERMINAL_ROWS + 1).is_err());
}

#[test]
fn validates_canonical_terminal_session_identifiers() {
    assert!(TerminalSessionId::try_from("terminal-1".to_owned()).is_ok());
    for identifier in ["", "terminal-", "terminal-0", "terminal-01", "terminal-x"] {
        assert!(TerminalSessionId::try_from(identifier.to_owned()).is_err());
    }
}

#[cfg(windows)]
#[test]
fn runs_and_reaps_the_native_windows_shell() -> AppResult<()> {
    const OUTPUT_MARKER: &str = "__SIDERAL_TERMINAL_OK__";

    let (output_sender, output_receiver) = mpsc::channel();
    let output = Channel::<Response>::new(move |body| {
        if let InvokeResponseBody::Raw(bytes) = body {
            let _ = output_sender.send(bytes);
        }
        Ok(())
    });
    let (event_sender, event_receiver) = mpsc::channel();
    let events = Channel::<TerminalEvent>::new(move |body| {
        if let InvokeResponseBody::Json(source) = body
            && let Ok(event) = serde_json::from_str::<TerminalEvent>(&source)
        {
            let _ = event_sender.send(event);
        }
        Ok(())
    });
    let working_directory = std::env::current_dir()
        .map_err(|error| AppError::io("could not resolve test working directory", error))?;
    let state = IntegratedTerminalState::new();
    let snapshot = state.create(OwnedTerminalCreation {
        columns: 80,
        events,
        home_directory: working_directory,
        output,
        owner_window: "test-window".to_owned(),
        rows: 24,
        workspace_root: None,
    })?;

    let startup_deadline = Instant::now() + Duration::from_secs(10);
    let mut observed_output = Vec::new();
    while !observed_output
        .windows(4)
        .any(|window| window == b"\x1b[6n")
    {
        let remaining = startup_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(AppError::Terminal(format!(
                "terminal did not request its initial cursor position; output: {}",
                String::from_utf8_lossy(&observed_output)
            )));
        }
        let chunk = output_receiver.recv_timeout(remaining).map_err(|error| {
            AppError::Terminal(format!(
                "terminal startup output timed out: {error}; output: {}",
                String::from_utf8_lossy(&observed_output)
            ))
        })?;
        observed_output.extend(chunk);
    }
    state.write("test-window", &snapshot.id, "\x1b[1;1R".to_owned())?;
    state.write(
        "test-window",
        &snapshot.id,
        format!("echo {OUTPUT_MARKER}\rexit\r"),
    )?;
    let event = match event_receiver.recv_timeout(Duration::from_secs(10)) {
        Ok(event) => event,
        Err(error) => {
            observed_output.extend(output_receiver.try_iter().flatten());
            let cleanup = state.close("test-window", &snapshot.id);
            return Err(AppError::Terminal(format!(
                "terminal test timed out: {error}; output: {}; cleanup: {cleanup:?}",
                String::from_utf8_lossy(&observed_output)
            )));
        }
    };
    state.close("test-window", &snapshot.id)?;

    observed_output.extend(output_receiver.try_iter().flatten());
    let observed_output = String::from_utf8_lossy(&observed_output);
    assert!(
        matches!(event, TerminalEvent::Exited { exit_code: 0, .. }),
        "unexpected terminal event: {event:?}; output: {observed_output}"
    );
    assert!(observed_output.contains(OUTPUT_MARKER));
    Ok(())
}

#[cfg(windows)]
#[test]
fn force_closes_and_reaps_the_native_windows_shell() -> AppResult<()> {
    let output = Channel::<Response>::new(|_| Ok(()));
    let events = Channel::<TerminalEvent>::new(|_| Ok(()));
    let working_directory = std::env::current_dir()
        .map_err(|error| AppError::io("could not resolve test working directory", error))?;
    let state = IntegratedTerminalState::new();
    let snapshot = state.create(OwnedTerminalCreation {
        columns: 80,
        events,
        home_directory: working_directory,
        output,
        owner_window: "test-window".to_owned(),
        rows: 24,
        workspace_root: None,
    })?;

    state.close("test-window", &snapshot.id)
}

#[cfg(windows)]
#[test]
fn falls_back_to_command_prompt_and_reports_the_primary_failure() -> AppResult<()> {
    let output = Channel::<Response>::new(|_| Ok(()));
    let events = Channel::<TerminalEvent>::new(|_| Ok(()));
    let working_directory = std::env::current_dir()
        .map_err(|error| AppError::io("could not resolve test working directory", error))?;
    let command_prompt = std::env::var_os("ComSpec").ok_or_else(|| {
        AppError::Terminal("ComSpec is unavailable in the test process".to_owned())
    })?;
    let command_prompt = std::fs::canonicalize(command_prompt)
        .map_err(|error| AppError::io("could not resolve the test Command Prompt", error))?;
    let missing_directory = tempfile::tempdir()
        .map_err(|error| AppError::io("could not create a terminal test directory", error))?;
    let mut session = TerminalSession::spawn(TerminalSpawnRequest {
        columns: 80,
        events,
        id: TerminalSessionId::try_from("terminal-1".to_owned()).map_err(AppError::Terminal)?,
        output,
        owner_window: "test-window".to_owned(),
        rows: 24,
        shells: vec![
            ShellCandidate::Ready(ShellProfile {
                arguments: &["-NoLogo", "-NoProfile"],
                executable: missing_directory.path().join("pwsh.exe"),
                name: "PowerShell 7",
            }),
            ShellCandidate::Ready(ShellProfile {
                arguments: &["/D"],
                executable: command_prompt,
                name: "Command Prompt",
            }),
        ],
        working_directory,
    })?;

    let snapshot = session.snapshot();
    assert_eq!(snapshot.shell_name, "Command Prompt");
    let fallback_reason = snapshot
        .shell_fallback_reason
        .as_deref()
        .ok_or_else(|| AppError::Terminal("terminal fallback was not reported".to_owned()))?;
    assert!(fallback_reason.contains("PowerShell 7"));
    assert!(fallback_reason.contains("pwsh.exe"));
    session.shutdown()
}
