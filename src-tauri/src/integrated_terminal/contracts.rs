use portable_pty::PtySize;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

pub(super) const MAX_TERMINAL_COLUMNS: u16 = 500;
pub(super) const MAX_TERMINAL_ROWS: u16 = 500;
pub(super) const MIN_TERMINAL_COLUMNS: u16 = 2;
pub(super) const MIN_TERMINAL_ROWS: u16 = 1;

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(try_from = "String", into = "String")]
pub struct TerminalSessionId(pub(super) String);

impl TryFrom<String> for TerminalSessionId {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        let Some(identifier) = value.strip_prefix("terminal-") else {
            return Err("terminal session identifier must start with `terminal-`".to_owned());
        };
        if identifier.is_empty()
            || identifier.starts_with('0')
            || !identifier.bytes().all(|byte| byte.is_ascii_digit())
            || identifier.parse::<u64>().is_err()
        {
            return Err("terminal session identifier is not canonical".to_owned());
        }
        Ok(Self(value))
    }
}

impl From<TerminalSessionId> for String {
    fn from(value: TerminalSessionId) -> Self {
        value.0
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionSnapshot {
    pub(super) id: TerminalSessionId,
    pub(super) process_id: Option<u32>,
    pub(super) shell_name: String,
    pub(super) working_directory: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalEvent {
    Exited {
        exit_code: u32,
        signal: Option<String>,
    },
    Failure {
        operation: TerminalFailureOperation,
        message: String,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TerminalFailureOperation {
    Output,
    Wait,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateIntegratedTerminalRequest {
    pub(super) workspace_root: Option<String>,
    pub(super) columns: u16,
    pub(super) rows: u16,
}

pub(super) fn validate_terminal_size(columns: u16, rows: u16) -> AppResult<()> {
    if !(MIN_TERMINAL_COLUMNS..=MAX_TERMINAL_COLUMNS).contains(&columns) {
        return Err(AppError::Terminal(format!(
            "terminal columns must be between {MIN_TERMINAL_COLUMNS} and {MAX_TERMINAL_COLUMNS}"
        )));
    }
    if !(MIN_TERMINAL_ROWS..=MAX_TERMINAL_ROWS).contains(&rows) {
        return Err(AppError::Terminal(format!(
            "terminal rows must be between {MIN_TERMINAL_ROWS} and {MAX_TERMINAL_ROWS}"
        )));
    }
    Ok(())
}

pub(super) fn terminal_size(columns: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols: columns,
        pixel_width: 0,
        pixel_height: 0,
    }
}
