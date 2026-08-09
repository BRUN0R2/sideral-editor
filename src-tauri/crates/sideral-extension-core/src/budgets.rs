use serde::Serialize;

pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
pub const RECOMMENDED_WORKER_BUNDLE_BYTES: usize = 256 * 1024;
pub const MAX_WORKER_BUNDLE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_COMPRESSED_PACKAGE_BYTES: usize = 10 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionSizeBudget {
    pub max_manifest_bytes: usize,
    pub recommended_worker_bundle_bytes: usize,
    pub max_worker_bundle_bytes: usize,
    pub max_compressed_package_bytes: usize,
}

pub const fn extension_size_budget() -> ExtensionSizeBudget {
    ExtensionSizeBudget {
        max_manifest_bytes: MAX_MANIFEST_BYTES,
        recommended_worker_bundle_bytes: RECOMMENDED_WORKER_BUNDLE_BYTES,
        max_worker_bundle_bytes: MAX_WORKER_BUNDLE_BYTES,
        max_compressed_package_bytes: MAX_COMPRESSED_PACKAGE_BYTES,
    }
}
