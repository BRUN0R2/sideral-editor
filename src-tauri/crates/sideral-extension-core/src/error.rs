use thiserror::Error;

#[derive(Debug, Error)]
pub enum ManifestError {
    #[error("manifest is {actual_bytes} bytes; the limit is {limit_bytes} bytes")]
    SourceTooLarge {
        actual_bytes: usize,
        limit_bytes: usize,
    },
    #[error("{artifact} is {actual_bytes} bytes; the limit is {limit_bytes} bytes")]
    ArtifactTooLarge {
        artifact: &'static str,
        actual_bytes: usize,
        limit_bytes: usize,
    },
    #[error("manifest JSON is invalid: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("manifest version {0} is not supported")]
    UnsupportedManifestVersion(u16),
    #[error("invalid `{field}`: {reason}")]
    InvalidField {
        field: &'static str,
        reason: String,
    },
    #[error("duplicate {kind}: {value}")]
    Duplicate {
        kind: &'static str,
        value: String,
    },
    #[error("inconsistent manifest: {0}")]
    Inconsistent(String),
}

impl ManifestError {
    pub(crate) fn invalid(field: &'static str, reason: impl Into<String>) -> Self {
        Self::InvalidField {
            field,
            reason: reason.into(),
        }
    }
}
