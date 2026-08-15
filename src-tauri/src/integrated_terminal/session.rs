use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    thread::{self, JoinHandle},
};

use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::ipc::{Channel, Response};

use super::{
    contracts::{
        TerminalEvent, TerminalFailureOperation, TerminalSessionId, TerminalSessionSnapshot,
        terminal_size,
    },
    shell::{ShellCandidate, ShellProfile, path_to_string},
};
use crate::error::{AppError, AppResult};

const CONTROL_QUEUE_CAPACITY: usize = 128;
const OUTPUT_CHUNK_BYTES: usize = 16 * 1024;

pub(super) struct TerminalSpawnRequest {
    pub(super) columns: u16,
    pub(super) events: Channel<TerminalEvent>,
    pub(super) id: TerminalSessionId,
    pub(super) output: Channel<Response>,
    pub(super) owner_window: String,
    pub(super) rows: u16,
    pub(super) shells: Vec<ShellCandidate>,
    pub(super) working_directory: PathBuf,
}

pub(super) struct TerminalSession {
    closing: Arc<AtomicBool>,
    control_sender: Option<SyncSender<TerminalControl>>,
    control_worker: Option<JoinHandle<()>>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    output_worker: Option<JoinHandle<()>>,
    owner_window: String,
    process: Arc<TerminalProcessState>,
    snapshot: TerminalSessionSnapshot,
    wait_worker: Option<JoinHandle<()>>,
}

pub(super) struct TerminalControlHandle {
    process: Arc<TerminalProcessState>,
    sender: SyncSender<TerminalControl>,
}

struct TerminalProcessState {
    exited: AtomicBool,
    wait_failure: Mutex<Option<String>>,
}

struct StartedTerminal {
    child: Box<dyn Child + Send + Sync>,
    fallback_reason: Option<String>,
    master: Box<dyn MasterPty + Send>,
    reader: Box<dyn Read + Send>,
    shell: ShellProfile,
    writer: Box<dyn Write + Send>,
}

enum TerminalControl {
    Resize {
        size: PtySize,
        response: mpsc::Sender<AppResult<()>>,
    },
    Shutdown,
    Write {
        data: String,
        response: mpsc::Sender<AppResult<()>>,
    },
}

fn start_terminal_process(
    columns: u16,
    rows: u16,
    shells: Vec<ShellCandidate>,
    working_directory: &Path,
) -> AppResult<StartedTerminal> {
    let pty_system = native_pty_system();
    let mut failures = Vec::new();

    for candidate in shells {
        let shell = match candidate {
            ShellCandidate::Ready(shell) => shell,
            ShellCandidate::Unavailable(reason) => {
                failures.push(reason);
                continue;
            }
        };
        let pair = pty_system
            .openpty(terminal_size(columns, rows))
            .map_err(|error| AppError::Terminal(format!("could not create native PTY: {error}")))?;
        let reader = pair.master.try_clone_reader().map_err(|error| {
            AppError::Terminal(format!("could not open terminal output stream: {error}"))
        })?;
        let writer = pair.master.take_writer().map_err(|error| {
            AppError::Terminal(format!("could not open terminal input stream: {error}"))
        })?;

        let mut command = CommandBuilder::new(&shell.executable);
        command.args(shell.arguments);
        command.cwd(working_directory);
        command.env("TERM_PROGRAM", "Sideral Editor");
        command.env("COLORTERM", "truecolor");
        let child = match pair.slave.spawn_command(command) {
            Ok(child) => child,
            Err(error) => {
                failures.push(format!(
                    "{} at {} could not be started: {error}",
                    shell.name,
                    shell.executable.display()
                ));
                continue;
            }
        };
        drop(pair.slave);

        return Ok(StartedTerminal {
            child,
            fallback_reason: (!failures.is_empty()).then(|| failures.join("; ")),
            master: pair.master,
            reader,
            shell,
            writer,
        });
    }

    let reason = if failures.is_empty() {
        "no shell candidates were provided".to_owned()
    } else {
        failures.join("; ")
    };
    Err(AppError::Terminal(format!(
        "no supported terminal shell could be started: {reason}"
    )))
}

impl TerminalSession {
    pub(super) fn spawn(request: TerminalSpawnRequest) -> AppResult<Self> {
        let TerminalSpawnRequest {
            columns,
            events,
            id,
            output,
            owner_window,
            rows,
            shells,
            working_directory,
        } = request;
        let working_directory_text =
            path_to_string(&working_directory, "terminal working directory")?;
        let StartedTerminal {
            child,
            fallback_reason,
            master,
            reader,
            shell,
            writer,
        } = start_terminal_process(columns, rows, shells, &working_directory)?;

        let process_id = child.process_id();
        let killer = Arc::new(Mutex::new(child.clone_killer()));
        let child = Arc::new(Mutex::new(child));
        let closing = Arc::new(AtomicBool::new(false));
        let process = Arc::new(TerminalProcessState::new());
        let worker_name = id.0.clone();
        let (control_sender, control_receiver) = mpsc::sync_channel(CONTROL_QUEUE_CAPACITY);

        let wait_child = Arc::clone(&child);
        let wait_closing = Arc::clone(&closing);
        let wait_control_sender = control_sender.clone();
        let wait_events = events.clone();
        let wait_process = Arc::clone(&process);
        let wait_worker = match thread::Builder::new()
            .name(format!("{worker_name}-wait"))
            .spawn(move || {
                wait_for_terminal_process(
                    wait_child,
                    wait_process,
                    wait_closing,
                    wait_events,
                    wait_control_sender,
                );
            }) {
            Ok(worker) => worker,
            Err(spawn_error) => {
                closing.store(true, Ordering::Release);
                drop(control_receiver);
                drop(control_sender);
                drop(writer);
                drop(reader);
                drop(master);
                let cleanup = terminate_unowned_child(&child);
                return Err(spawn_failure("wait", spawn_error, cleanup));
            }
        };
        drop(child);

        let control_killer = Arc::clone(&killer);
        let control_process = Arc::clone(&process);
        let control_worker = match thread::Builder::new()
            .name(format!("{worker_name}-control"))
            .spawn(move || {
                control_terminal(
                    master,
                    writer,
                    control_receiver,
                    control_killer,
                    control_process,
                );
            }) {
            Ok(worker) => worker,
            Err(spawn_error) => {
                closing.store(true, Ordering::Release);
                let cleanup = terminate_and_join(&killer, &process, vec![("wait", wait_worker)]);
                return Err(spawn_failure("control", spawn_error, cleanup));
            }
        };

        let output_killer = Arc::clone(&killer);
        let output_closing = Arc::clone(&closing);
        let output_control_sender = control_sender.clone();
        let output_process = Arc::clone(&process);
        let output_worker = match thread::Builder::new()
            .name(format!("{worker_name}-output"))
            .spawn(move || {
                read_terminal_output(
                    reader,
                    output,
                    events,
                    output_control_sender,
                    output_killer,
                    output_process,
                    output_closing,
                );
            }) {
            Ok(worker) => worker,
            Err(spawn_error) => {
                closing.store(true, Ordering::Release);
                request_terminal_shutdown(&control_sender);
                let cleanup = terminate_and_join(
                    &killer,
                    &process,
                    vec![("control", control_worker), ("wait", wait_worker)],
                );
                return Err(spawn_failure("output", spawn_error, cleanup));
            }
        };

        Ok(Self {
            closing,
            control_sender: Some(control_sender),
            control_worker: Some(control_worker),
            killer,
            output_worker: Some(output_worker),
            owner_window,
            process,
            snapshot: TerminalSessionSnapshot {
                id,
                process_id,
                shell_fallback_reason: fallback_reason,
                shell_name: shell.name.to_owned(),
                working_directory: working_directory_text,
            },
            wait_worker: Some(wait_worker),
        })
    }

    pub(super) fn belongs_to(&self, owner_window: &str) -> bool {
        self.owner_window == owner_window
    }

    pub(super) fn control_handle(&self) -> AppResult<TerminalControlHandle> {
        let sender =
            self.control_sender.as_ref().cloned().ok_or_else(|| {
                AppError::Terminal("terminal control channel is closed".to_owned())
            })?;
        Ok(TerminalControlHandle {
            process: Arc::clone(&self.process),
            sender,
        })
    }

    pub(super) fn snapshot(&self) -> TerminalSessionSnapshot {
        self.snapshot.clone()
    }

    pub(super) fn shutdown(&mut self) -> AppResult<()> {
        self.closing.store(true, Ordering::Release);
        let mut failures = Vec::new();
        if let Some(sender) = self.control_sender.take() {
            request_terminal_shutdown(&sender);
        }
        let termination_failure = terminate_process(&self.killer, &self.process).err();
        for (name, worker) in [
            ("control", self.control_worker.take()),
            ("wait", self.wait_worker.take()),
            ("output", self.output_worker.take()),
        ] {
            if let Some(worker) = worker
                && worker.join().is_err()
            {
                failures.push(format!("{name} worker panicked"));
            }
        }
        match self.process.wait_failure() {
            Ok(Some(failure)) => failures.push(failure),
            Ok(None) => {}
            Err(error) => failures.push(error.to_string()),
        }
        if !self.process.has_exited() {
            failures.push(termination_failure.map_or_else(
                || "terminal process exit was not confirmed".to_owned(),
                |error| error.to_string(),
            ));
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(AppError::Terminal(failures.join("; ")))
        }
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        if let Err(error) = self.shutdown() {
            eprintln!(
                "Terminal session {} did not shut down cleanly: {error}",
                self.snapshot.id.0
            );
        }
    }
}

impl TerminalControlHandle {
    pub(super) fn resize(&self, size: PtySize) -> AppResult<()> {
        self.request(|response| TerminalControl::Resize { size, response })
    }

    pub(super) fn write(&self, data: String) -> AppResult<()> {
        self.request(|response| TerminalControl::Write { data, response })
    }

    fn request(
        &self,
        request: impl FnOnce(mpsc::Sender<AppResult<()>>) -> TerminalControl,
    ) -> AppResult<()> {
        if self.process.has_exited() {
            return Err(AppError::Terminal(
                "the terminal process has already exited".to_owned(),
            ));
        }
        let (response_sender, response_receiver) = mpsc::channel();
        self.sender
            .send(request(response_sender))
            .map_err(|_| AppError::Terminal("terminal control worker is unavailable".to_owned()))?;
        response_receiver.recv().map_err(|_| {
            AppError::Terminal("terminal control response was interrupted".to_owned())
        })?
    }
}

impl TerminalProcessState {
    fn new() -> Self {
        Self {
            exited: AtomicBool::new(false),
            wait_failure: Mutex::new(None),
        }
    }

    fn has_exited(&self) -> bool {
        self.exited.load(Ordering::Acquire)
    }

    fn record_exit(&self, failure: Option<String>) {
        let mut wait_failure = match self.wait_failure.lock() {
            Ok(wait_failure) => wait_failure,
            Err(error) => error.into_inner(),
        };
        *wait_failure = failure;
        self.exited.store(true, Ordering::Release);
    }

    fn wait_failure(&self) -> AppResult<Option<String>> {
        self.wait_failure
            .lock()
            .map(|failure| failure.clone())
            .map_err(|_| AppError::Terminal("terminal process state lock is poisoned".to_owned()))
    }
}

fn control_terminal(
    master: Box<dyn MasterPty + Send>,
    mut writer: Box<dyn Write + Send>,
    receiver: Receiver<TerminalControl>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    process: Arc<TerminalProcessState>,
) {
    while let Ok(control) = receiver.recv() {
        let failed = match control {
            TerminalControl::Resize { size, response } => {
                let result = master.resize(size).map_err(|error| {
                    AppError::Terminal(format!("could not resize terminal PTY: {error}"))
                });
                let failed = result.is_err();
                let _ = response.send(result);
                failed
            }
            TerminalControl::Shutdown => break,
            TerminalControl::Write { data, response } => {
                let result = writer
                    .write_all(data.as_bytes())
                    .and_then(|()| writer.flush())
                    .map_err(|error| AppError::io("could not write terminal input", error));
                let failed = result.is_err();
                let _ = response.send(result);
                failed
            }
        };
        if failed {
            let _ = terminate_process(&killer, &process);
            break;
        }
    }
}

fn read_terminal_output(
    mut reader: Box<dyn Read + Send>,
    output: Channel<Response>,
    events: Channel<TerminalEvent>,
    control_sender: SyncSender<TerminalControl>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    process: Arc<TerminalProcessState>,
    closing: Arc<AtomicBool>,
) {
    let mut buffer = vec![0_u8; OUTPUT_CHUNK_BYTES];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(bytes_read) => {
                let bytes = buffer[..bytes_read].to_vec();
                if output.send(Response::new(bytes)).is_err() {
                    if !closing.load(Ordering::Acquire) {
                        let _ = events.send(TerminalEvent::Failure {
                            operation: TerminalFailureOperation::Output,
                            message: "terminal output channel is unavailable".to_owned(),
                        });
                        request_terminal_shutdown(&control_sender);
                        let _ = terminate_process(&killer, &process);
                    }
                    break;
                }
            }
            Err(error) => {
                if !closing.load(Ordering::Acquire) {
                    let _ = events.send(TerminalEvent::Failure {
                        operation: TerminalFailureOperation::Output,
                        message: format!("could not read terminal output: {error}"),
                    });
                    request_terminal_shutdown(&control_sender);
                    let _ = terminate_process(&killer, &process);
                }
                break;
            }
        }
    }
}

fn request_terminal_shutdown(sender: &SyncSender<TerminalControl>) {
    let _ = sender.try_send(TerminalControl::Shutdown);
}

fn wait_for_terminal_process(
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    process: Arc<TerminalProcessState>,
    closing: Arc<AtomicBool>,
    events: Channel<TerminalEvent>,
    control_sender: SyncSender<TerminalControl>,
) {
    let result = child
        .lock()
        .map_err(|_| AppError::Terminal("terminal child lock is poisoned".to_owned()))
        .and_then(|mut child| {
            child.wait().map_err(|wait_error| {
                let cleanup = child.kill().and_then(|()| child.wait());
                match cleanup {
                    Ok(_) => AppError::io("could not wait for terminal process", wait_error),
                    Err(cleanup_error) => AppError::Terminal(format!(
                        "could not wait for terminal process: {wait_error}; cleanup failed: {cleanup_error}"
                    )),
                }
            })
        });
    process.record_exit(result.as_ref().err().map(ToString::to_string));
    if closing.load(Ordering::Acquire) {
        return;
    }
    let event = match result {
        Ok(status) => TerminalEvent::Exited {
            exit_code: status.exit_code(),
            signal: status.signal().map(str::to_owned),
        },
        Err(error) => TerminalEvent::Failure {
            operation: TerminalFailureOperation::Wait,
            message: error.to_string(),
        },
    };
    if events.send(event).is_err() {
        request_terminal_shutdown(&control_sender);
    }
}

fn terminate_process(
    killer: &Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    process: &TerminalProcessState,
) -> AppResult<()> {
    if process.has_exited() {
        return Ok(());
    }
    let result = killer
        .lock()
        .map_err(|_| AppError::Terminal("terminal process killer lock is poisoned".to_owned()))?
        .kill();
    match result {
        Ok(()) => Ok(()),
        Err(_) if process.has_exited() => Ok(()),
        Err(error) => Err(AppError::io("could not terminate terminal process", error)),
    }
}

fn terminate_unowned_child(child: &Arc<Mutex<Box<dyn Child + Send + Sync>>>) -> AppResult<()> {
    let mut child = child
        .lock()
        .map_err(|_| AppError::Terminal("terminal child lock is poisoned".to_owned()))?;
    if child
        .try_wait()
        .map_err(|error| AppError::io("could not inspect terminal process", error))?
        .is_none()
    {
        child
            .kill()
            .map_err(|error| AppError::io("could not terminate terminal process", error))?;
        child
            .wait()
            .map_err(|error| AppError::io("could not reap terminal process", error))?;
    }
    Ok(())
}

fn terminate_and_join(
    killer: &Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    process: &TerminalProcessState,
    workers: Vec<(&'static str, JoinHandle<()>)>,
) -> AppResult<()> {
    let mut failures = Vec::new();
    let termination_failure = terminate_process(killer, process).err();
    for (name, worker) in workers {
        if worker.join().is_err() {
            failures.push(format!("{name} worker panicked"));
        }
    }
    match process.wait_failure() {
        Ok(Some(failure)) => failures.push(failure),
        Ok(None) => {}
        Err(error) => failures.push(error.to_string()),
    }
    if !process.has_exited() {
        failures.push(termination_failure.map_or_else(
            || "terminal process exit was not confirmed".to_owned(),
            |error| error.to_string(),
        ));
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(AppError::Terminal(failures.join("; ")))
    }
}

fn spawn_failure(worker: &str, spawn_error: std::io::Error, cleanup: AppResult<()>) -> AppError {
    match cleanup {
        Ok(()) => AppError::io(
            format!("could not start terminal {worker} worker"),
            spawn_error,
        ),
        Err(cleanup_error) => AppError::Terminal(format!(
            "could not start terminal {worker} worker: {spawn_error}; cleanup failed: {cleanup_error}"
        )),
    }
}
