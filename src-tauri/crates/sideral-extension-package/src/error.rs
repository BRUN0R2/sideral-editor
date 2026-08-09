use thiserror::Error;

#[derive(Debug, Error)]
pub enum PackageError {
    #[error("could not read extension package: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid extension archive: {0}")]
    Archive(#[from] zip::result::ZipError),
    #[error("invalid extension manifest: {0}")]
    Manifest(#[from] sideral_extension_core::ManifestError),
    #[error("invalid extension package: {0}")]
    Invalid(String),
    #[error("invalid extension signature: {0}")]
    Signature(String),
}

impl PackageError {
    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid(message.into())
    }

    pub(crate) fn signature(message: impl Into<String>) -> Self {
        Self::Signature(message.into())
    }
}
