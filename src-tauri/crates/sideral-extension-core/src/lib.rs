#![forbid(unsafe_code)]

mod budgets;
mod error;
mod manifest;
mod package;
mod permissions;

pub use budgets::{ExtensionSizeBudget, extension_size_budget};
pub use error::ManifestError;
pub use manifest::{
    CommandContribution, Contributions, EngineRequirements, ExtensionInspection,
    ExtensionManifest, RuntimeKind, WorkerRuntime, validate_manifest_json,
};
pub use package::{BundleSizeAssessment, assess_worker_bundle_size, validate_package_size};
pub use permissions::{PermissionSet, ProcessPermission, WorkspaceAccess};
