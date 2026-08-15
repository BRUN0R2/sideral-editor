use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Condvar, Mutex, MutexGuard},
};

use tauri::ipc::{Channel, Response};

use crate::error::{AppError, AppResult};

pub(crate) mod commands;
mod contracts;
mod session;
mod shell;

pub use commands::request_shutdown;

use contracts::{
    TerminalEvent, TerminalSessionId, TerminalSessionSnapshot, terminal_size,
    validate_terminal_size,
};
use session::{TerminalControlHandle, TerminalSession, TerminalSpawnRequest};
use shell::{resolve_shell_candidates, resolve_working_directory};

const MAX_INPUT_BYTES: usize = 1024 * 1024;
const MAX_TERMINAL_SESSIONS: usize = 8;

#[derive(Clone)]
pub struct IntegratedTerminalState {
    inner: Arc<TerminalRegistryState>,
}

struct TerminalRegistryState {
    registry: Mutex<TerminalRegistry>,
    reservation_changed: Condvar,
}

struct TerminalRegistry {
    accepting_sessions: bool,
    next_identifier: u64,
    pending_sessions: usize,
    sessions: HashMap<TerminalSessionId, TerminalSession>,
}

struct OwnedTerminalCreation {
    columns: u16,
    events: Channel<TerminalEvent>,
    home_directory: PathBuf,
    output: Channel<Response>,
    owner_window: String,
    rows: u16,
    workspace_root: Option<String>,
}

impl IntegratedTerminalState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(TerminalRegistryState {
                registry: Mutex::new(TerminalRegistry {
                    accepting_sessions: true,
                    next_identifier: 1,
                    pending_sessions: 0,
                    sessions: HashMap::new(),
                }),
                reservation_changed: Condvar::new(),
            }),
        }
    }

    fn create(&self, request: OwnedTerminalCreation) -> AppResult<TerminalSessionSnapshot> {
        let OwnedTerminalCreation {
            columns,
            events,
            home_directory,
            output,
            owner_window,
            rows,
            workspace_root,
        } = request;
        validate_terminal_size(columns, rows)?;
        let working_directory = resolve_working_directory(workspace_root, home_directory)?;
        let shells = resolve_shell_candidates();
        let session_id = self.reserve_session()?;
        let session_result = TerminalSession::spawn(TerminalSpawnRequest {
            columns,
            events,
            id: session_id,
            output,
            owner_window,
            rows,
            shells,
            working_directory,
        });

        let mut registry = self.lock_registry()?;
        registry.pending_sessions = registry.pending_sessions.checked_sub(1).ok_or_else(|| {
            AppError::Terminal("terminal session reservation accounting is invalid".to_owned())
        })?;
        self.inner.reservation_changed.notify_all();
        let session = session_result?;
        if !registry.accepting_sessions {
            drop(registry);
            let mut session = session;
            let cleanup = session.shutdown();
            return match cleanup {
                Ok(()) => Err(AppError::Terminal(
                    "the terminal service is shutting down".to_owned(),
                )),
                Err(error) => Err(AppError::Terminal(format!(
                    "the terminal service is shutting down; new session cleanup failed: {error}"
                ))),
            };
        }

        let snapshot = session.snapshot();
        if registry.sessions.contains_key(&snapshot.id) {
            drop(registry);
            let mut session = session;
            let cleanup = session.shutdown();
            if let Err(error) = cleanup {
                return Err(AppError::Terminal(format!(
                    "terminal session identifier collision; cleanup failed: {error}"
                )));
            }
            return Err(AppError::Terminal(
                "terminal session identifier collision".to_owned(),
            ));
        }
        registry.sessions.insert(snapshot.id.clone(), session);
        Ok(snapshot)
    }

    fn write(
        &self,
        owner_window: &str,
        session_id: &TerminalSessionId,
        data: String,
    ) -> AppResult<()> {
        if data.is_empty() {
            return Ok(());
        }
        if data.len() > MAX_INPUT_BYTES {
            return Err(AppError::Terminal(format!(
                "terminal input exceeds the {MAX_INPUT_BYTES}-byte limit"
            )));
        }
        self.control_handle(owner_window, session_id)?.write(data)
    }

    fn resize(
        &self,
        owner_window: &str,
        session_id: &TerminalSessionId,
        columns: u16,
        rows: u16,
    ) -> AppResult<()> {
        validate_terminal_size(columns, rows)?;
        self.control_handle(owner_window, session_id)?
            .resize(terminal_size(columns, rows))
    }

    fn close(&self, owner_window: &str, session_id: &TerminalSessionId) -> AppResult<()> {
        let mut registry = self.lock_registry()?;
        let Some(session) = registry.sessions.get(session_id) else {
            return Err(AppError::TerminalSessionNotFound(session_id.0.clone()));
        };
        if !session.belongs_to(owner_window) {
            return Err(AppError::Terminal(
                "terminal session belongs to another window".to_owned(),
            ));
        }
        let Some(mut session) = registry.sessions.remove(session_id) else {
            return Err(AppError::TerminalSessionNotFound(session_id.0.clone()));
        };
        drop(registry);
        session.shutdown()
    }

    pub fn shutdown_all(&self) -> AppResult<()> {
        let sessions = {
            let mut registry = self.lock_registry()?;
            registry.accepting_sessions = false;
            registry = self
                .inner
                .reservation_changed
                .wait_while(registry, |registry| registry.pending_sessions > 0)
                .map_err(|_| {
                    AppError::Terminal("terminal session registry lock is poisoned".to_owned())
                })?;
            registry
                .sessions
                .drain()
                .map(|(_, session)| session)
                .collect::<Vec<_>>()
        };

        let mut failures = Vec::new();
        for mut session in sessions {
            if let Err(error) = session.shutdown() {
                failures.push(error.to_string());
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(AppError::Terminal(format!(
                "terminal shutdown failed: {}",
                failures.join("; ")
            )))
        }
    }

    fn reserve_session(&self) -> AppResult<TerminalSessionId> {
        let mut registry = self.lock_registry()?;
        if !registry.accepting_sessions {
            return Err(AppError::Terminal(
                "the terminal service is shutting down".to_owned(),
            ));
        }
        let allocated_sessions = registry
            .sessions
            .len()
            .saturating_add(registry.pending_sessions);
        if allocated_sessions >= MAX_TERMINAL_SESSIONS {
            return Err(AppError::Terminal(format!(
                "the application cannot own more than {MAX_TERMINAL_SESSIONS} terminal sessions"
            )));
        }

        let identifier = registry.next_identifier;
        registry.next_identifier = identifier.checked_add(1).ok_or_else(|| {
            AppError::Terminal("terminal session identifiers are exhausted".to_owned())
        })?;
        registry.pending_sessions = registry.pending_sessions.checked_add(1).ok_or_else(|| {
            AppError::Terminal("terminal session reservation limit is exhausted".to_owned())
        })?;
        Ok(TerminalSessionId(format!("terminal-{identifier}")))
    }

    fn control_handle(
        &self,
        owner_window: &str,
        session_id: &TerminalSessionId,
    ) -> AppResult<TerminalControlHandle> {
        let registry = self.lock_registry()?;
        let session = registry
            .sessions
            .get(session_id)
            .ok_or_else(|| AppError::TerminalSessionNotFound(session_id.0.clone()))?;
        if !session.belongs_to(owner_window) {
            return Err(AppError::Terminal(
                "terminal session belongs to another window".to_owned(),
            ));
        }
        session.control_handle()
    }

    fn lock_registry(&self) -> AppResult<MutexGuard<'_, TerminalRegistry>> {
        self.inner.registry.lock().map_err(|_| {
            AppError::Terminal("terminal session registry lock is poisoned".to_owned())
        })
    }
}

impl Drop for TerminalRegistryState {
    fn drop(&mut self) {
        let registry = match self.registry.get_mut() {
            Ok(registry) => registry,
            Err(error) => error.into_inner(),
        };
        registry.accepting_sessions = false;
        for (_, mut session) in registry.sessions.drain() {
            if let Err(error) = session.shutdown() {
                eprintln!("Integrated terminal shutdown failed: {error}");
            }
        }
    }
}

#[cfg(test)]
mod tests;
