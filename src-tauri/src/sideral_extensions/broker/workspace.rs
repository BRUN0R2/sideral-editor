use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use globset::GlobBuilder;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sideral_extension_core::{ExtensionManifest, LanguageContribution, WorkspaceAccess};
use url::Url;

use super::{
    Cancellation, CapabilityBroker, FindFilesPayload, TrackedDocument, WriteDocumentPayload,
    atomic_write, lock, read_bounded_file, read_lock, run_blocking,
};
use crate::sideral_extensions::error::ExtensionError;

const MAX_TEXT_DOCUMENT_BYTES: u64 = 4 * 1024 * 1024;
const DEFAULT_FIND_LIMIT: usize = 100;
const MAX_FIND_LIMIT: usize = 1_000;
const MAX_TRAVERSED_ENTRIES: usize = 100_000;

impl CapabilityBroker {
    pub(super) async fn read_workspace_document(
        &self,
        manifest: &ExtensionManifest,
        uri: String,
    ) -> Result<Value, ExtensionError> {
        let broker = self.clone();
        let languages = manifest.contributes.languages.clone();
        run_blocking(move || broker.read_workspace_document_blocking(&uri, &languages)).await
    }

    pub(super) fn read_workspace_document_blocking(
        &self,
        uri: &str,
        languages: &[LanguageContribution],
    ) -> Result<Value, ExtensionError> {
        let path = self.canonical_workspace_file(uri)?;
        let mut versions = lock(
            &self.shared.document_versions,
            "extension document versions",
        )?;
        let bytes = read_bounded_file(&path, MAX_TEXT_DOCUMENT_BYTES, "workspace document")?;
        if bytes.contains(&0) {
            return Err(ExtensionError::InvalidRequest(
                "workspace document is binary".to_owned(),
            ));
        }
        let content = String::from_utf8(bytes)
            .map_err(|_| ExtensionError::InvalidRequest("document is not UTF-8".to_owned()))?;
        let content_sha256 = sha256_hex(content.as_bytes());
        let version = track_document_version(&mut versions, &path, &content_sha256);
        Ok(json!({
            "uri": file_uri(&path)?,
            "languageId": language_id(&path, languages),
            "version": version,
            "content": content,
        }))
    }

    pub(super) async fn write_workspace_document(
        &self,
        manifest: &ExtensionManifest,
        payload: WriteDocumentPayload,
    ) -> Result<Value, ExtensionError> {
        if payload.content.len() as u64 > MAX_TEXT_DOCUMENT_BYTES {
            return Err(ExtensionError::InvalidRequest(format!(
                "document exceeds {MAX_TEXT_DOCUMENT_BYTES} bytes"
            )));
        }
        if payload.content.contains('\0') {
            return Err(ExtensionError::InvalidRequest(
                "workspace document content cannot contain NUL bytes".to_owned(),
            ));
        }
        let broker = self.clone();
        let languages = manifest.contributes.languages.clone();
        run_blocking(move || broker.write_workspace_document_blocking(payload, &languages)).await
    }

    pub(super) fn write_workspace_document_blocking(
        &self,
        payload: WriteDocumentPayload,
        languages: &[LanguageContribution],
    ) -> Result<Value, ExtensionError> {
        let path = self.canonical_workspace_file(&payload.uri)?;
        let mut versions = lock(
            &self.shared.document_versions,
            "extension document versions",
        )?;
        let existing = read_bounded_file(&path, MAX_TEXT_DOCUMENT_BYTES, "workspace document")?;
        if existing.contains(&0) || std::str::from_utf8(&existing).is_err() {
            return Err(ExtensionError::InvalidRequest(
                "workspace document is not UTF-8 text".to_owned(),
            ));
        }
        let existing_sha256 = sha256_hex(&existing);
        let current_version = track_document_version(&mut versions, &path, &existing_sha256);
        if current_version != payload.expected_version {
            return Err(ExtensionError::Conflict(format!(
                "document version changed: expected {}, current {current_version}",
                payload.expected_version
            )));
        }
        atomic_write(&path, payload.content.as_bytes())?;
        let content_sha256 = sha256_hex(payload.content.as_bytes());
        let version = current_version.saturating_add(1);
        versions.insert(
            path.clone(),
            TrackedDocument {
                content_sha256,
                version,
            },
        );
        Ok(json!({
            "uri": file_uri(&path)?,
            "languageId": language_id(&path, languages),
            "version": version,
            "content": payload.content,
        }))
    }

    pub(super) async fn find_workspace_files(
        &self,
        payload: FindFilesPayload,
        cancellation: Arc<Cancellation>,
    ) -> Result<Value, ExtensionError> {
        let broker = self.clone();
        run_blocking(move || broker.find_workspace_files_blocking(payload, &cancellation)).await
    }

    pub(super) fn find_workspace_files_blocking(
        &self,
        payload: FindFilesPayload,
        cancellation: &Cancellation,
    ) -> Result<Value, ExtensionError> {
        if payload.pattern.is_empty()
            || payload.pattern.len() > 256
            || payload.pattern.contains('\\')
        {
            return Err(ExtensionError::InvalidRequest(
                "file pattern must be a non-empty, forward-slash glob of at most 256 bytes"
                    .to_owned(),
            ));
        }
        let limit = payload.limit.unwrap_or(DEFAULT_FIND_LIMIT);
        if !(1..=MAX_FIND_LIMIT).contains(&limit) {
            return Err(ExtensionError::InvalidRequest(format!(
                "find limit must be between 1 and {MAX_FIND_LIMIT}"
            )));
        }
        let matcher = GlobBuilder::new(&payload.pattern)
            .literal_separator(true)
            .build()
            .map_err(|error| ExtensionError::InvalidRequest(format!("invalid glob: {error}")))?
            .compile_matcher();
        let roots = self.workspace_roots()?;
        let mut queue: VecDeque<_> = roots.into_iter().map(|root| (root.clone(), root)).collect();
        let mut matches = Vec::new();
        let mut matched_uris = HashSet::new();
        let mut traversed = 0_usize;
        while let Some((root, directory)) = queue.pop_front() {
            if cancellation.is_cancelled() {
                return Err(ExtensionError::Cancelled);
            }
            let entries = fs::read_dir(&directory).map_err(|error| {
                ExtensionError::io(format!("could not read {}", directory.display()), error)
            })?;
            let mut entries = entries.collect::<Result<Vec<_>, _>>().map_err(|error| {
                ExtensionError::io(
                    format!("could not read an entry in {}", directory.display()),
                    error,
                )
            })?;
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                if cancellation.is_cancelled() {
                    return Err(ExtensionError::Cancelled);
                }
                traversed = traversed.saturating_add(1);
                if traversed > MAX_TRAVERSED_ENTRIES {
                    return Err(ExtensionError::InvalidRequest(format!(
                        "workspace search exceeded {MAX_TRAVERSED_ENTRIES} entries"
                    )));
                }
                let file_type = entry.file_type().map_err(|error| {
                    ExtensionError::io(
                        format!("could not inspect {}", entry.path().display()),
                        error,
                    )
                })?;
                if file_type.is_symlink() {
                    continue;
                }
                if file_type.is_dir() {
                    queue.push_back((root.clone(), entry.path()));
                    continue;
                }
                if !file_type.is_file() {
                    continue;
                }
                let path = entry.path();
                let relative = path.strip_prefix(&root).map_err(|_| {
                    ExtensionError::Runtime("workspace traversal escaped its root".to_owned())
                })?;
                let candidate = relative.to_string_lossy().replace('\\', "/");
                if matcher.is_match(&candidate) {
                    let uri = file_uri(&path)?;
                    if !matched_uris.insert(uri.clone()) {
                        continue;
                    }
                    matches.push(uri);
                    if matches.len() == limit {
                        matches.sort();
                        return serde_json::to_value(matches)
                            .map_err(|error| ExtensionError::Runtime(error.to_string()));
                    }
                }
            }
        }
        matches.sort();
        serde_json::to_value(matches).map_err(|error| ExtensionError::Runtime(error.to_string()))
    }

    pub(super) fn canonical_workspace_file(&self, uri: &str) -> Result<PathBuf, ExtensionError> {
        let roots = self.workspace_roots()?;
        let path = workspace_uri_path(uri)?;
        let canonical = fs::canonicalize(&path).map_err(|error| {
            ExtensionError::io(format!("could not resolve {}", path.display()), error)
        })?;
        if !roots.iter().any(|root| canonical.starts_with(root)) || !canonical.is_file() {
            return Err(ExtensionError::PermissionDenied(format!(
                "{} is outside the active workspace or is not a file",
                canonical.display()
            )));
        }
        Ok(canonical)
    }

    pub(super) fn canonical_workspace_directory(
        &self,
        uri: &str,
    ) -> Result<PathBuf, ExtensionError> {
        let roots = self.workspace_roots()?;
        let path = workspace_uri_path(uri)?;
        let canonical = fs::canonicalize(&path).map_err(|error| {
            ExtensionError::io(format!("could not resolve {}", path.display()), error)
        })?;
        if !roots.iter().any(|root| canonical.starts_with(root)) || !canonical.is_dir() {
            return Err(ExtensionError::PermissionDenied(format!(
                "{} is outside the active workspace or is not a directory",
                canonical.display()
            )));
        }
        Ok(canonical)
    }

    pub(super) fn workspace_output_file(&self, uri: &str) -> Result<PathBuf, ExtensionError> {
        let roots = self.workspace_roots()?;
        let path = workspace_uri_path(uri)?;
        let file_name = path.file_name().ok_or_else(|| {
            ExtensionError::InvalidRequest("workspace output URI has no file name".to_owned())
        })?;
        if matches!(file_name.to_str(), Some("." | "..")) {
            return Err(ExtensionError::InvalidRequest(
                "workspace output URI has an invalid file name".to_owned(),
            ));
        }
        if path.exists() {
            let canonical = fs::canonicalize(&path).map_err(|error| {
                ExtensionError::io(format!("could not resolve {}", path.display()), error)
            })?;
            if !roots.iter().any(|root| canonical.starts_with(root)) || !canonical.is_file() {
                return Err(ExtensionError::PermissionDenied(format!(
                    "{} is outside the active workspace or is not a file",
                    canonical.display()
                )));
            }
            return Ok(canonical);
        }
        let parent = path.parent().ok_or_else(|| {
            ExtensionError::InvalidRequest("workspace output URI has no parent".to_owned())
        })?;
        let canonical_parent = fs::canonicalize(parent).map_err(|error| {
            ExtensionError::io(format!("could not resolve {}", parent.display()), error)
        })?;
        if !roots.iter().any(|root| canonical_parent.starts_with(root))
            || !canonical_parent.is_dir()
        {
            return Err(ExtensionError::PermissionDenied(format!(
                "{} is outside the active workspace or is not a directory",
                canonical_parent.display()
            )));
        }
        Ok(canonical_parent.join(file_name))
    }

    pub(super) fn workspace_root(&self) -> Result<PathBuf, ExtensionError> {
        read_lock(&self.shared.workspace_scope, "extension workspace")?
            .active
            .clone()
            .ok_or_else(|| {
                ExtensionError::InvalidRequest("select an open workspace folder".to_owned())
            })
    }

    pub(super) fn workspace_roots(&self) -> Result<Vec<PathBuf>, ExtensionError> {
        let roots = read_lock(&self.shared.workspace_scope, "extension workspace")?
            .roots
            .clone();
        if roots.is_empty() {
            return Err(ExtensionError::InvalidRequest(
                "no workspace is open".to_owned(),
            ));
        }
        Ok(roots)
    }
}

fn workspace_uri_path(uri: &str) -> Result<PathBuf, ExtensionError> {
    let parsed = Url::parse(uri)
        .map_err(|error| ExtensionError::InvalidRequest(format!("invalid file URI: {error}")))?;
    if parsed.scheme() != "file" {
        return Err(ExtensionError::InvalidRequest(
            "workspace documents must use file URIs".to_owned(),
        ));
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(ExtensionError::InvalidRequest(
            "workspace file URIs cannot contain credentials, queries or fragments".to_owned(),
        ));
    }
    parsed.to_file_path().map_err(|()| {
        ExtensionError::InvalidRequest("workspace URI is not a valid file path".to_owned())
    })
}

pub(super) fn require_workspace_permission(
    manifest: &ExtensionManifest,
    write: bool,
) -> Result<(), ExtensionError> {
    let permitted = match (manifest.permissions.workspace, write) {
        (WorkspaceAccess::Read | WorkspaceAccess::ReadWrite, false)
        | (WorkspaceAccess::ReadWrite, true) => true,
        (WorkspaceAccess::None | WorkspaceAccess::Metadata | WorkspaceAccess::Read, true)
        | (WorkspaceAccess::None | WorkspaceAccess::Metadata, false) => false,
    };
    if permitted {
        Ok(())
    } else {
        Err(ExtensionError::PermissionDenied(format!(
            "extension {} does not have {} workspace access",
            manifest.id,
            if write { "write" } else { "read" }
        )))
    }
}

fn track_document_version(
    versions: &mut HashMap<PathBuf, TrackedDocument>,
    path: &Path,
    content_sha256: &str,
) -> u64 {
    match versions.get_mut(path) {
        Some(document) if document.content_sha256 == content_sha256 => document.version,
        Some(document) => {
            document.content_sha256 = content_sha256.to_owned();
            document.version = document.version.saturating_add(1);
            document.version
        }
        None => {
            versions.insert(
                path.to_path_buf(),
                TrackedDocument {
                    content_sha256: content_sha256.to_owned(),
                    version: 1,
                },
            );
            1
        }
    }
}

pub(super) fn file_uri(path: &Path) -> Result<String, ExtensionError> {
    Url::from_file_path(path)
        .map(|uri| uri.to_string())
        .map_err(|()| ExtensionError::Runtime(format!("{} has no file URI", path.display())))
}

fn language_id(path: &Path, languages: &[LanguageContribution]) -> String {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| format!(".{}", extension.to_ascii_lowercase()));
    if let Some(language) = extension.as_deref().and_then(|extension| {
        languages.iter().find(|language| {
            language
                .extensions
                .iter()
                .any(|candidate| candidate == extension)
        })
    }) {
        return language.id.clone();
    }
    match extension.as_deref() {
        Some(".css") => "css",
        Some(".html" | ".htm") => "html",
        Some(".js" | ".mjs" | ".cjs") => "javascript",
        Some(".json" | ".jsonc") => "json",
        Some(".md") => "markdown",
        Some(".py") => "python",
        Some(".rs") => "rust",
        Some(".ts" | ".mts" | ".cts") => "typescript",
        Some(".tsx") => "typescriptreact",
        Some(".jsx") => "javascriptreact",
        Some(".toml") => "toml",
        Some(".xml") => "xml",
        Some(".yaml" | ".yml") => "yaml",
        _ => "plaintext",
    }
    .to_owned()
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}
