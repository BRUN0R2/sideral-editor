use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Cursor, Read},
};

use serde::Serialize;
use sideral_extension_core::{
    ExtensionInspection, ExtensionManifest, assess_worker_bundle_size, parse_manifest_json,
    validate_package_path, validate_package_size,
};
use zip::ZipArchive;

use crate::{PackageError, PublisherIdentity, sha256_hex, verify_signature};

const MANIFEST_PATH: &str = "manifest.json";
const SIGNATURE_PATH: &str = "signature.json";
const MAX_ARCHIVE_FILES: usize = 256;
const MAX_UNCOMPRESSED_PACKAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatedExtensionPackage {
    pub manifest: ExtensionManifest,
    pub inspection: ExtensionInspection,
    pub publisher: PublisherIdentity,
    pub package_sha256: String,
    pub bundle_sha256: String,
    pub bundle: Vec<u8>,
}

pub fn validate_package_bytes(bytes: &[u8]) -> Result<ValidatedExtensionPackage, PackageError> {
    validate_package_size(bytes.len())?;
    let mut archive = ZipArchive::new(Cursor::new(bytes))?;
    if archive.is_empty() || archive.len() > MAX_ARCHIVE_FILES {
        return Err(PackageError::invalid(format!(
            "archive must contain between 1 and {MAX_ARCHIVE_FILES} files"
        )));
    }

    let mut files = BTreeMap::new();
    let mut case_folded_paths = BTreeSet::new();
    let mut total_uncompressed = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let path = entry.name().to_owned();
        validate_archive_entry(&entry, &path)?;
        let folded = windows_path_key(&path)?;
        if !case_folded_paths.insert(folded) || files.contains_key(&path) {
            return Err(PackageError::invalid(format!(
                "archive contains a duplicate or case-colliding path: {path}"
            )));
        }
        total_uncompressed = total_uncompressed
            .checked_add(entry.size())
            .ok_or_else(|| {
                PackageError::invalid("archive uncompressed size exceeds the supported range")
            })?;
        if total_uncompressed > MAX_UNCOMPRESSED_PACKAGE_BYTES {
            return Err(PackageError::invalid(format!(
                "archive exceeds the {MAX_UNCOMPRESSED_PACKAGE_BYTES}-byte uncompressed limit"
            )));
        }

        let expected_size = usize::try_from(entry.size())
            .map_err(|_| PackageError::invalid(format!("{path} is too large")))?;
        let mut content = Vec::with_capacity(expected_size);
        entry
            .by_ref()
            .take(MAX_SINGLE_FILE_BYTES + 1)
            .read_to_end(&mut content)?;
        if content.len() as u64 != entry.size() || content.len() as u64 > MAX_SINGLE_FILE_BYTES {
            return Err(PackageError::invalid(format!(
                "{path} exceeds its declared or permitted size"
            )));
        }
        files.insert(path, content);
    }

    let manifest_bytes = files
        .get(MANIFEST_PATH)
        .ok_or_else(|| PackageError::invalid("manifest.json is missing"))?;
    let manifest_source = std::str::from_utf8(manifest_bytes)
        .map_err(|error| PackageError::invalid(format!("manifest.json is not UTF-8: {error}")))?;
    let manifest_bytes = manifest_source.len();
    let manifest = parse_manifest_json(manifest_source)?;
    validate_allowed_files(&files, &manifest)?;

    let runtime = manifest
        .runtime
        .as_ref()
        .ok_or_else(|| PackageError::invalid("package has no worker runtime"))?;
    let bundle = files
        .get(&runtime.entry)
        .ok_or_else(|| PackageError::invalid(format!("worker entry {} is missing", runtime.entry)))?
        .clone();
    assess_worker_bundle_size(bundle.len())?;

    let signature_source = files
        .remove(SIGNATURE_PATH)
        .ok_or_else(|| PackageError::invalid("signature.json is missing"))?;
    let publisher = verify_signature(&signature_source, &files, &manifest.id)?;
    let inspection = manifest.inspect(manifest_bytes);

    Ok(ValidatedExtensionPackage {
        manifest,
        inspection,
        publisher,
        package_sha256: sha256_hex(bytes),
        bundle_sha256: sha256_hex(&bundle),
        bundle,
    })
}

fn validate_archive_entry<R: Read>(
    entry: &zip::read::ZipFile<'_, R>,
    path: &str,
) -> Result<(), PackageError> {
    validate_package_path("package entry", path)?;
    if entry.is_dir() || entry.is_symlink() || !entry.is_file() {
        return Err(PackageError::invalid(format!(
            "archive entry {path} must be a regular file"
        )));
    }
    if entry.encrypted() {
        return Err(PackageError::invalid(format!(
            "archive entry {path} cannot be encrypted"
        )));
    }
    if entry.size() > MAX_SINGLE_FILE_BYTES {
        return Err(PackageError::invalid(format!(
            "archive entry {path} exceeds the per-file limit"
        )));
    }
    Ok(())
}

fn validate_allowed_files(
    files: &BTreeMap<String, Vec<u8>>,
    manifest: &ExtensionManifest,
) -> Result<(), PackageError> {
    let runtime_entry = manifest
        .runtime
        .as_ref()
        .map(|runtime| runtime.entry.as_str());
    for path in files.keys() {
        let allowed = matches!(path.as_str(), MANIFEST_PATH | SIGNATURE_PATH)
            || Some(path.as_str()) == runtime_entry
            || path.starts_with("assets/");
        if !allowed {
            return Err(PackageError::invalid(format!(
                "unsupported package file: {path}"
            )));
        }
    }
    Ok(())
}

fn windows_path_key(path: &str) -> Result<String, PackageError> {
    let mut segments = Vec::new();
    for segment in path.split('/') {
        if segment.ends_with(' ') || segment.ends_with('.') {
            return Err(PackageError::invalid(format!(
                "package path is not portable to Windows: {path}"
            )));
        }
        let normalized = segment.trim_end_matches([' ', '.']).to_ascii_lowercase();
        if normalized.is_empty() || is_windows_reserved_name(&normalized) {
            return Err(PackageError::invalid(format!(
                "package path is not portable to Windows: {path}"
            )));
        }
        segments.push(normalized);
    }
    Ok(segments.join("/"))
}

fn is_windows_reserved_name(segment: &str) -> bool {
    let stem = segment.split('.').next().map_or(segment, |value| value);
    matches!(stem, "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}
