#![forbid(unsafe_code)]

mod budgets;
mod error;
mod manifest;
mod package;
mod permissions;

pub use budgets::{ExtensionSizeBudget, extension_size_budget};
pub use error::ManifestError;
pub use manifest::{
    CommandContribution, CommandInvocation, Contributions, EngineRequirements, ExtensionInspection,
    ExtensionManifest, KeybindingContribution, RuntimeKind, WorkerRuntime, normalize_keybinding,
    parse_manifest_json, validate_manifest_json, validate_package_path,
};
pub use package::{BundleSizeAssessment, assess_worker_bundle_size, validate_package_size};
pub use permissions::{
    NetworkMethod, NetworkPermission, PermissionSet, ProcessPermission, WorkspaceAccess,
};
