use serde::Serialize;

use crate::{
    ManifestError,
    budgets::{
        MAX_COMPRESSED_PACKAGE_BYTES, MAX_WORKER_BUNDLE_BYTES, RECOMMENDED_WORKER_BUNDLE_BYTES,
    },
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleSizeAssessment {
    pub actual_bytes: usize,
    pub recommended_bytes: usize,
    pub maximum_bytes: usize,
    pub exceeds_recommendation: bool,
}

pub fn assess_worker_bundle_size(
    actual_bytes: usize,
) -> Result<BundleSizeAssessment, ManifestError> {
    if actual_bytes > MAX_WORKER_BUNDLE_BYTES {
        return Err(ManifestError::ArtifactTooLarge {
            artifact: "worker bundle",
            actual_bytes,
            limit_bytes: MAX_WORKER_BUNDLE_BYTES,
        });
    }

    Ok(BundleSizeAssessment {
        actual_bytes,
        recommended_bytes: RECOMMENDED_WORKER_BUNDLE_BYTES,
        maximum_bytes: MAX_WORKER_BUNDLE_BYTES,
        exceeds_recommendation: actual_bytes > RECOMMENDED_WORKER_BUNDLE_BYTES,
    })
}

pub fn validate_package_size(compressed_bytes: usize) -> Result<(), ManifestError> {
    if compressed_bytes > MAX_COMPRESSED_PACKAGE_BYTES {
        return Err(ManifestError::ArtifactTooLarge {
            artifact: "compressed extension package",
            actual_bytes: compressed_bytes,
            limit_bytes: MAX_COMPRESSED_PACKAGE_BYTES,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{assess_worker_bundle_size, validate_package_size};
    use crate::{
        ManifestError,
        budgets::{
            MAX_COMPRESSED_PACKAGE_BYTES, MAX_WORKER_BUNDLE_BYTES, RECOMMENDED_WORKER_BUNDLE_BYTES,
        },
    };

    #[test]
    fn flags_a_bundle_above_the_recommendation() {
        let result = assess_worker_bundle_size(RECOMMENDED_WORKER_BUNDLE_BYTES + 1);

        assert!(matches!(
            result,
            Ok(assessment) if assessment.exceeds_recommendation
        ));
    }

    #[test]
    fn rejects_a_bundle_above_the_hard_limit() {
        let result = assess_worker_bundle_size(MAX_WORKER_BUNDLE_BYTES + 1);

        assert!(matches!(
            result,
            Err(ManifestError::ArtifactTooLarge {
                artifact: "worker bundle",
                ..
            })
        ));
    }

    #[test]
    fn rejects_a_package_above_the_hard_limit() {
        let result = validate_package_size(MAX_COMPRESSED_PACKAGE_BYTES + 1);

        assert!(matches!(
            result,
            Err(ManifestError::ArtifactTooLarge {
                artifact: "compressed extension package",
                ..
            })
        ));
    }
}
