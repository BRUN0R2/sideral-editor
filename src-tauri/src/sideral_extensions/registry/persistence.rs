use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sideral_extension_core::{extension_size_budget, validate_package_size};
use sideral_extension_package::ValidatedExtensionPackage;
use tempfile::NamedTempFile;

use super::PACKAGES_DIRECTORY_NAME;
use crate::sideral_extensions::error::ExtensionError;

pub(super) fn package_relative_path(package: &ValidatedExtensionPackage) -> String {
    let short_hash = package
        .package_sha256
        .get(..16)
        .map_or(package.package_sha256.as_str(), |value| value);
    format!(
        "{PACKAGES_DIRECTORY_NAME}/{}/{}-{short_hash}.sideralx",
        package.manifest.id, package.manifest.version
    )
}

pub(super) fn persist_package(
    destination: &Path,
    bytes: &[u8],
    expected_sha256: &str,
) -> Result<(), ExtensionError> {
    if destination.exists() {
        let existing = fs::read(destination).map_err(|error| {
            ExtensionError::io(format!("could not read {}", destination.display()), error)
        })?;
        if sideral_extension_package::sha256_hex(&existing) == expected_sha256 {
            return Ok(());
        }
        return Err(ExtensionError::Conflict(format!(
            "package destination {} already contains different data",
            destination.display()
        )));
    }
    let parent = destination.parent().ok_or_else(|| {
        ExtensionError::InvalidRegistry(format!(
            "package destination {} has no parent",
            destination.display()
        ))
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        ExtensionError::io(
            format!("could not create package directory {}", parent.display()),
            error,
        )
    })?;
    let mut temporary = NamedTempFile::new_in(parent).map_err(|error| {
        ExtensionError::io(
            format!("could not create temporary package in {}", parent.display()),
            error,
        )
    })?;
    temporary
        .write_all(bytes)
        .and_then(|()| temporary.as_file_mut().sync_all())
        .map_err(|error| {
            ExtensionError::io("could not persist temporary extension package", error)
        })?;
    temporary.persist_noclobber(destination).map_err(|error| {
        ExtensionError::io(
            format!("could not install package at {}", destination.display()),
            error.error,
        )
    })?;
    Ok(())
}

pub(super) fn read_package(path: &Path) -> Result<Vec<u8>, ExtensionError> {
    if path.extension().and_then(|value| value.to_str()) != Some("sideralx") {
        return Err(ExtensionError::InvalidPackage(
            "extension package must use the .sideralx suffix".to_owned(),
        ));
    }
    let file = fs::File::open(path)
        .map_err(|error| ExtensionError::io(format!("could not open {}", path.display()), error))?;
    let metadata = file.metadata().map_err(|error| {
        ExtensionError::io(format!("could not inspect {}", path.display()), error)
    })?;
    if !metadata.is_file() {
        return Err(ExtensionError::InvalidPackage(format!(
            "{} is not a regular file",
            path.display()
        )));
    }
    let size = usize::try_from(metadata.len())
        .map_err(|_| ExtensionError::InvalidPackage("extension package is too large".to_owned()))?;
    validate_package_size(size)
        .map_err(|error| ExtensionError::InvalidPackage(error.to_string()))?;
    let limit = extension_size_budget().max_compressed_package_bytes;
    read_bounded(file, limit)
        .map_err(|error| ExtensionError::io(format!("could not read {}", path.display()), error))
}

pub(super) fn read_json_document<T: for<'de> Deserialize<'de>>(
    path: &Path,
    limit: u64,
) -> Result<Option<T>, ExtensionError> {
    if !path.exists() {
        return Ok(None);
    }
    let file = fs::File::open(path)
        .map_err(|error| ExtensionError::io(format!("could not open {}", path.display()), error))?;
    let metadata = file.metadata().map_err(|error| {
        ExtensionError::io(format!("could not inspect {}", path.display()), error)
    })?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(ExtensionError::InvalidRegistry(format!(
            "{} is not a bounded registry file",
            path.display()
        )));
    }
    let source = read_bounded(
        file,
        usize::try_from(limit).map_err(|_| {
            ExtensionError::InvalidRegistry(format!("{} has an invalid size limit", path.display()))
        })?,
    )
    .map_err(|error| ExtensionError::io(format!("could not read {}", path.display()), error))?;
    serde_json::from_slice(&source)
        .map(Some)
        .map_err(|error| ExtensionError::InvalidRegistry(error.to_string()))
}

pub(super) fn write_json_document<T: Serialize>(
    path: &Path,
    value: &T,
    limit: u64,
) -> Result<(), ExtensionError> {
    let parent = path.parent().ok_or_else(|| {
        ExtensionError::InvalidRegistry(format!("{} has no parent", path.display()))
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        ExtensionError::io(
            format!("could not create extension directory {}", parent.display()),
            error,
        )
    })?;
    let mut serialized = serde_json::to_vec_pretty(value)
        .map_err(|error| ExtensionError::InvalidRegistry(error.to_string()))?;
    serialized.push(b'\n');
    if serialized.len() as u64 > limit {
        return Err(ExtensionError::InvalidRegistry(format!(
            "{} exceeds its {limit}-byte limit",
            path.display()
        )));
    }
    let mut temporary = NamedTempFile::new_in(parent).map_err(|error| {
        ExtensionError::io(
            format!(
                "could not create temporary registry in {}",
                parent.display()
            ),
            error,
        )
    })?;
    temporary
        .write_all(&serialized)
        .and_then(|()| temporary.as_file_mut().sync_all())
        .map_err(|error| ExtensionError::io("could not persist extension registry", error))?;
    temporary.persist(path).map_err(|error| {
        ExtensionError::io(
            format!("could not atomically replace {}", path.display()),
            error.error,
        )
    })?;
    Ok(())
}

pub(crate) fn remove_installed_packages(paths: Vec<PathBuf>) -> Result<(), ExtensionError> {
    for path in paths {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(ExtensionError::io(
                    format!("could not remove {}", path.display()),
                    error,
                ));
            }
        }
    }
    Ok(())
}

fn read_bounded(file: fs::File, limit: usize) -> std::io::Result<Vec<u8>> {
    let read_limit = u64::try_from(limit).unwrap_or(u64::MAX).saturating_add(1);
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    file.take(read_limit).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("file exceeds its {limit}-byte limit"),
        ));
    }
    Ok(bytes)
}
