use std::{ffi::OsString, path::Path};

use super::{
    launch::{LaunchFiles, MAX_LAUNCH_TARGETS, parse_launch},
    queue::FileOpenQueue,
};
use crate::{desktop_integration::MINIMIZED_STARTUP_ARGUMENT, error::AppResult};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;

type ReceivedInstructions = Arc<Mutex<Vec<serde_json::Value>>>;

fn channel() -> (Channel<super::FileOpenInstruction>, ReceivedInstructions) {
    let messages = Arc::new(Mutex::new(Vec::new()));
    let received = messages.clone();
    let channel = Channel::new(move |response| {
        let message = response.deserialize::<serde_json::Value>()?;
        received
            .lock()
            .map_err(|_| std::io::Error::other("the test message store is unavailable"))?
            .push(message);
        Ok(())
    });
    (channel, messages)
}

#[test]
fn reconnect_replays_unacknowledged_requests_and_stale_cleanup_preserves_the_new_owner()
-> Result<(), Box<dyn std::error::Error>> {
    let state = super::FileOpeningState::default();
    state.submit(files("first.ts"), true)?;
    let (first_channel, first_messages) = channel();
    state.connect("first".to_owned(), first_channel)?;
    assert_eq!(
        first_messages
            .lock()
            .map_err(|_| "first message store is poisoned")?
            .len(),
        1
    );
    let (second_channel, second_messages) = channel();
    state.connect("second".to_owned(), second_channel)?;
    state.disconnect("first")?;
    state.submit(files("second.ts"), true)?;
    assert_eq!(
        second_messages
            .lock()
            .map_err(|_| "second message store is poisoned")?
            .len(),
        2
    );
    assert!(state.acknowledge("first", 1).is_err());
    state.acknowledge("second", 1)?;
    state.acknowledge("second", 2)?;
    assert!(state.lock()?.queue.requests.is_empty());
    Ok(())
}

#[test]
fn reveal_requests_are_retained_before_the_main_window_exists() -> AppResult<()> {
    let state = super::FileOpeningState::default();
    state.submit(LaunchFiles::default(), false)?;
    assert!(!state.requires_visible_startup()?);
    state.submit(LaunchFiles::default(), true)?;
    assert!(state.requires_visible_startup()?);
    state.submit(LaunchFiles::default(), false)?;
    assert!(state.requires_visible_startup()?);
    Ok(())
}

fn parse(arguments: &[&str]) -> super::launch::ParsedLaunch {
    parse_launch(arguments.iter().map(OsString::from), &std::env::temp_dir())
}

fn files(path: &str) -> LaunchFiles {
    LaunchFiles {
        paths: vec![path.to_owned()],
        errors: Vec::new(),
    }
}

#[test]
fn resolves_unicode_and_space_paths_against_the_launch_directory() {
    let launch = parse(&["projeto com espaços/ação.ts", "outro.rs"]);
    assert_eq!(launch.files.paths.len(), 2);
    assert!(launch.files.errors.is_empty());
    assert!(
        launch
            .files
            .paths
            .iter()
            .all(|path| Path::new(path).is_absolute())
    );
    assert!(launch.files.paths[0].ends_with("ação.ts"));
}

#[test]
fn reuses_duplicate_paths_and_keeps_the_requested_order() {
    let launch = parse(&["first.ts", "first.ts", "second.rs"]);
    assert_eq!(launch.files.paths.len(), 2);
    assert!(launch.files.paths[0].ends_with("first.ts"));
    assert!(launch.files.paths[1].ends_with("second.rs"));
}

#[test]
fn startup_stays_hidden_until_an_explicit_file_or_error_requests_attention() {
    let startup = parse(&[MINIMIZED_STARTUP_ARGUMENT]);
    assert!(!startup.reveal_window);
    assert!(startup.files.is_empty());
    assert!(parse(&[MINIMIZED_STARTUP_ARGUMENT, "main.rs"]).reveal_window);
    assert!(parse(&[MINIMIZED_STARTUP_ARGUMENT, "--unknown"]).reveal_window);
    assert!(parse(&[]).reveal_window);
}

#[test]
fn option_terminator_opens_dash_prefixed_names_as_files() {
    let launch = parse(&["--", "--notes.txt"]);
    assert!(launch.files.errors.is_empty());
    assert_eq!(launch.files.paths.len(), 1);
    assert!(launch.files.paths[0].ends_with("--notes.txt"));
}

#[test]
fn invalid_options_do_not_discard_valid_files() {
    let launch = parse(&["--unknown", "main.rs", ""]);
    assert_eq!(launch.files.paths.len(), 1);
    assert_eq!(launch.files.errors.len(), 2);
}

#[test]
fn rejects_relative_targets_without_an_absolute_launch_directory() {
    let launch = parse_launch([OsString::from("main.rs")], Path::new("relative"));
    assert!(launch.files.paths.is_empty());
    assert_eq!(launch.files.errors.len(), 1);
}

#[test]
fn oversized_launch_is_bounded_and_reports_the_rejected_remainder() {
    let arguments = (0..=MAX_LAUNCH_TARGETS).map(|index| OsString::from(format!("{index}.ts")));
    let launch = parse_launch(arguments, &std::env::temp_dir());
    assert_eq!(launch.files.paths.len(), MAX_LAUNCH_TARGETS);
    assert_eq!(launch.files.errors.len(), 1);
}

#[test]
fn queue_retains_requests_until_they_are_acknowledged_in_order() -> AppResult<()> {
    let mut queue = FileOpenQueue::default();
    let first = queue.enqueue(files("first.ts"))?.ok_or_else(|| {
        crate::error::AppError::Runtime("the first request was not queued".to_owned())
    })?;
    let second = queue.enqueue(files("second.ts"))?.ok_or_else(|| {
        crate::error::AppError::Runtime("the second request was not queued".to_owned())
    })?;
    assert!(queue.acknowledge(second.id).is_err());
    assert_eq!(queue.requests.len(), 2);
    queue.acknowledge(first.id)?;
    assert_eq!(queue.requests.len(), 1);
    queue.acknowledge(second.id)?;
    assert!(queue.requests.is_empty());
    Ok(())
}

#[test]
fn queue_rejects_an_oversized_backlog_without_losing_accepted_requests() -> AppResult<()> {
    let mut queue = FileOpenQueue::default();
    queue.enqueue(files("accepted.ts"))?;
    assert!(queue.enqueue(files(&"a".repeat(1024 * 1024))).is_err());
    assert_eq!(queue.requests.len(), 1);
    assert_eq!(queue.requests[0].files.paths, ["accepted.ts"]);
    Ok(())
}
