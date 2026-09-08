#![forbid(unsafe_code)]

mod budgets;
mod configuration;
mod error;
mod manifest;
mod package;
mod permissions;

pub use budgets::{ExtensionSizeBudget, extension_size_budget};
pub use configuration::{ConfigurationContribution, ConfigurationProperty};
pub use error::ManifestError;
pub use manifest::{
    CommandContribution, CommandDocumentSync, CommandInvocation, Contributions, EngineRequirements,
    ExtensionInspection, ExtensionManifest, KeybindingContribution, LanguageContribution,
    RuntimeKind, WorkerRuntime, normalize_keybinding, parse_manifest_json, validate_manifest_json,
    validate_package_path,
};

pub use package::{BundleSizeAssessment, assess_worker_bundle_size, validate_package_size};
pub use permissions::{
    DiscordApplicationId, DiscordPresencePermission, NetworkMethod, NetworkPermission,
    PermissionSet, ProcessArgument, ProcessExecutable, ProcessPathAccess, ProcessPermission,
    ProcessWorkingDirectory, WorkspaceAccess,
};
