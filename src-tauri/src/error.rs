use serde::Serialize;
use thiserror::Error;

pub type AppResult<T> = Result<T, AppError>;
pub type CommandResult<T> = Result<T, CommandError>;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("{context}: {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid path: {0}")]
    InvalidPath(String),
    #[error("invalid file name: {0}")]
    InvalidFileName(String),
    #[error("a file or folder named {0} already exists")]
    FileAlreadyExists(String),
    #[error("invalid external URL: {0}")]
    InvalidExternalUrl(String),
    #[error("invalid locale: {0}")]
    InvalidLocale(String),
    #[error("invalid settings: {0}")]
    InvalidSettings(String),
    #[error("invalid Sideral extension: {0}")]
    InvalidSideralExtension(String),
    #[error("JSON schema error: {0}")]
    JsonSchema(String),
    #[error("integrated terminal error: {0}")]
    Terminal(String),
    #[error("terminal session not found: {0}")]
    TerminalSessionNotFound(String),
    #[error("file exceeds the {limit_megabytes} MiB safety limit")]
    FileTooLarge { limit_megabytes: u64 },
    #[error("binary files are not supported")]
    BinaryFile,
    #[error("the file is not valid UTF-8 text")]
    InvalidUtf8,
    #[error("runtime task failed: {0}")]
    Runtime(String),
}

impl AppError {
    pub fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        Self::Io {
            context: context.into(),
            source,
        }
    }

    fn code(&self) -> &'static str {
        match self {
            Self::Io { .. } => "io_error",
            Self::InvalidPath(_) => "invalid_path",
            Self::InvalidFileName(_) => "invalid_file_name",
            Self::FileAlreadyExists(_) => "file_already_exists",
            Self::InvalidExternalUrl(_) => "invalid_external_url",
            Self::InvalidLocale(_) => "invalid_locale",
            Self::InvalidSettings(_) => "invalid_settings",
            Self::InvalidSideralExtension(_) => "invalid_sideral_extension",
            Self::JsonSchema(_) => "json_schema_error",
            Self::Terminal(_) => "terminal_error",
            Self::TerminalSessionNotFound(_) => "terminal_session_not_found",
            Self::FileTooLarge { .. } => "file_too_large",
            Self::BinaryFile => "binary_file",
            Self::InvalidUtf8 => "invalid_utf8",
            Self::Runtime(_) => "runtime_error",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub code: &'static str,
    pub message: String,
}

impl From<AppError> for CommandError {
    fn from(error: AppError) -> Self {
        Self {
            code: error.code(),
            message: error.to_string(),
        }
    }
}
