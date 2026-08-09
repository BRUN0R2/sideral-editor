use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ExtensionError {
    #[error("{context}: {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid extension registry: {0}")]
    InvalidRegistry(String),
    #[error("invalid extension package: {0}")]
    InvalidPackage(String),
    #[error("extension {0} is not installed")]
    NotFound(String),
    #[error("extension {0} is disabled")]
    Disabled(String),
    #[error("extension {extension_id} requires Sideral {requirement}")]
    Incompatible {
        extension_id: String,
        requirement: String,
    },
    #[error("extension host is not connected")]
    HostUnavailable,
    #[error("extension host session is invalid")]
    InvalidHostSession,
    #[error("extension protocol version {0} is unsupported")]
    ProtocolMismatch(u16),
    #[error("invalid extension runtime transition: {0}")]
    InvalidRuntimeState(String),
    #[error("extension request is invalid: {0}")]
    InvalidRequest(String),
    #[error("extension permission denied: {0}")]
    PermissionDenied(String),
    #[error("extension operation exceeded its deadline")]
    DeadlineExceeded,
    #[error("extension operation was cancelled")]
    Cancelled,
    #[error("extension state conflict: {0}")]
    Conflict(String),
    #[error("extension runtime failed: {0}")]
    Runtime(String),
}

impl ExtensionError {
    pub fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        Self::Io {
            context: context.into(),
            source,
        }
    }

    pub const fn code(&self) -> &'static str {
        match self {
            Self::Io { .. } => "extension_io_error",
            Self::InvalidRegistry(_) => "invalid_extension_registry",
            Self::InvalidPackage(_) => "invalid_extension_package",
            Self::NotFound(_) => "extension_not_found",
            Self::Disabled(_) => "extension_disabled",
            Self::Incompatible { .. } => "extension_incompatible",
            Self::HostUnavailable => "extension_host_unavailable",
            Self::InvalidHostSession => "invalid_extension_host_session",
            Self::ProtocolMismatch(_) => "extension_protocol_mismatch",
            Self::InvalidRuntimeState(_) => "invalid_extension_runtime_state",
            Self::InvalidRequest(_) => "invalid_extension_request",
            Self::PermissionDenied(_) => "extension_permission_denied",
            Self::DeadlineExceeded => "extension_deadline_exceeded",
            Self::Cancelled => "extension_cancelled",
            Self::Conflict(_) => "extension_conflict",
            Self::Runtime(_) => "extension_runtime_error",
        }
    }
}

impl From<sideral_extension_package::PackageError> for ExtensionError {
    fn from(error: sideral_extension_package::PackageError) -> Self {
        Self::InvalidPackage(error.to_string())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionCommandError {
    pub code: &'static str,
    pub message: String,
}

impl From<ExtensionError> for ExtensionCommandError {
    fn from(error: ExtensionError) -> Self {
        Self {
            code: error.code(),
            message: error.to_string(),
        }
    }
}
