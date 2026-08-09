use sideral_extension_core::ExtensionInspection;
use vscode_legacy_core::LegacyInspection;

use crate::error::{AppError, AppResult};

pub(crate) fn validate_sideral_manifest(source: &str) -> AppResult<ExtensionInspection> {
    sideral_extension_core::validate_manifest_json(source)
        .map_err(|error| AppError::InvalidSideralExtension(error.to_string()))
}

pub(crate) fn inspect_legacy_manifest(source: &str) -> AppResult<LegacyInspection> {
    vscode_legacy_core::inspect_manifest_json(source)
        .map_err(|error| AppError::InvalidLegacyExtension(error.to_string()))
}
