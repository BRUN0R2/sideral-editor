use std::{
    collections::{BTreeSet, HashMap, VecDeque},
    fs,
    io::Write,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};

use reqwest::{
    Client, StatusCode,
    header::{ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED, LOCATION},
    redirect::Policy,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tempfile::NamedTempFile;
use url::{Host, Url};

use crate::error::{AppError, AppResult};

const TRUST_FILE_NAME: &str = "json-schema-trust.json";
const TRUST_SCHEMA_VERSION: u8 = 1;
const MAX_TRUST_FILE_BYTES: u64 = 64 * 1024;
const MAX_SCHEMA_BYTES: usize = 4 * 1024 * 1024;
const MAX_SCHEMA_GRAPH_BYTES: usize = 16 * 1024 * 1024;
const MAX_SCHEMA_GRAPH_ENTRIES: usize = 64;
const MAX_REDIRECTS: usize = 5;
const MAX_CACHE_ENTRIES: usize = 64;
const REMOTE_CACHE_TTL: Duration = Duration::from_secs(15 * 60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);

const BUILT_IN_TRUSTED_ORIGINS: [&str; 6] = [
    "https://biomejs.dev",
    "https://developer.microsoft.com",
    "https://json-schema.org",
    "https://json.schemastore.org",
    "https://schema.tauri.app",
    "https://www.schemastore.org",
];

fn build_http_client() -> AppResult<Client> {
    Client::builder()
        .redirect(Policy::none())
        .https_only(true)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .user_agent(concat!("Sideral-Editor/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| {
            AppError::JsonSchema(format!("could not initialize the HTTP client: {error}"))
        })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustDocument {
    schema_version: u8,
    origins: BTreeSet<String>,
    uris: BTreeSet<String>,
}

impl Default for TrustDocument {
    fn default() -> Self {
        Self {
            schema_version: TRUST_SCHEMA_VERSION,
            origins: BTreeSet::new(),
            uris: BTreeSet::new(),
        }
    }
}

impl TrustDocument {
    fn validate(mut self) -> AppResult<Self> {
        if self.schema_version != TRUST_SCHEMA_VERSION {
            return Err(AppError::InvalidSettings(format!(
                "JSON schema trust version {} is unsupported",
                self.schema_version
            )));
        }
        self.origins = self
            .origins
            .into_iter()
            .map(|origin| normalize_origin(&origin))
            .collect::<AppResult<_>>()?;
        self.uris = self
            .uris
            .into_iter()
            .map(|uri| normalize_remote_uri(&uri).map(|url| normalized_remote_url(&url)))
            .collect::<AppResult<_>>()?;
        Ok(self)
    }

    fn is_trusted(&self, uri: &Url) -> bool {
        let origin = origin_of(uri);
        BUILT_IN_TRUSTED_ORIGINS.contains(&origin.as_str())
            || self.origins.contains(&origin)
            || self.uris.contains(&normalized_remote_url(uri))
    }

    fn snapshot(&self) -> JsonSchemaTrustSettings {
        JsonSchemaTrustSettings {
            built_in_origins: BUILT_IN_TRUSTED_ORIGINS
                .iter()
                .map(|origin| (*origin).to_owned())
                .collect(),
            origins: self.origins.iter().cloned().collect(),
            uris: self.uris.iter().cloned().collect(),
        }
    }
}

#[derive(Clone, Debug)]
enum CacheValidator {
    Local(FileStamp),
    Remote {
        etag: Option<String>,
        last_modified: Option<String>,
        retrieval_uri: String,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileStamp {
    length: u64,
    modified: Option<SystemTime>,
}

#[derive(Clone, Debug)]
struct CachedSchema {
    schema: Value,
    bytes: usize,
    loaded_at: Instant,
    validator: CacheValidator,
}

#[derive(Debug, Default)]
struct SchemaCache {
    entries: HashMap<String, CachedSchema>,
    order: VecDeque<String>,
}

impl SchemaCache {
    fn get(&mut self, key: &str) -> Option<CachedSchema> {
        let entry = self.entries.get(key)?.clone();
        self.touch(key);
        Some(entry)
    }

    fn insert(&mut self, key: String, entry: CachedSchema) {
        self.entries.insert(key.clone(), entry);
        self.touch(&key);
        while self.entries.len() > MAX_CACHE_ENTRIES {
            if let Some(expired) = self.order.pop_front() {
                self.entries.remove(&expired);
            }
        }
    }

    fn refresh(&mut self, key: &str) -> Option<CachedSchema> {
        let entry = self.entries.get_mut(key)?;
        entry.loaded_at = Instant::now();
        let entry = entry.clone();
        self.touch(key);
        Some(entry)
    }

    fn touch(&mut self, key: &str) {
        self.order.retain(|current| current != key);
        self.order.push_back(key.to_owned());
    }
}

#[derive(Debug)]
pub struct JsonSchemaState {
    client: Client,
    trust_path: PathBuf,
    trust: Mutex<TrustDocument>,
    cache: Mutex<SchemaCache>,
}

impl JsonSchemaState {
    pub fn load(app: &AppHandle) -> AppResult<Self> {
        let trust_path = app
            .path()
            .app_config_dir()
            .map_err(|error| AppError::InvalidPath(error.to_string()))?
            .join(TRUST_FILE_NAME);
        let trust = read_trust(&trust_path)?;
        let client = build_http_client()?;

        Ok(Self {
            client,
            trust_path,
            trust: Mutex::new(trust),
            cache: Mutex::new(SchemaCache::default()),
        })
    }

    pub fn trust_settings(&self) -> AppResult<JsonSchemaTrustSettings> {
        self.trust
            .lock()
            .map(|trust| trust.snapshot())
            .map_err(|_| AppError::Runtime("JSON schema trust is unavailable".to_owned()))
    }

    pub fn trust_location(
        &self,
        uri: &str,
        scope: JsonSchemaTrustScope,
    ) -> AppResult<JsonSchemaTrustSettings> {
        let url = normalize_remote_uri(uri)?;
        let mut current = self
            .trust
            .lock()
            .map_err(|_| AppError::Runtime("JSON schema trust is unavailable".to_owned()))?;
        let mut next = current.clone();
        match scope {
            JsonSchemaTrustScope::Uri => {
                next.uris.insert(normalized_remote_url(&url));
            }
            JsonSchemaTrustScope::Origin => {
                next.origins.insert(origin_of(&url));
            }
        }
        write_trust(&self.trust_path, &next)?;
        *current = next;
        Ok(current.snapshot())
    }

    pub fn revoke_trust(
        &self,
        value: &str,
        scope: JsonSchemaTrustScope,
    ) -> AppResult<JsonSchemaTrustSettings> {
        let mut current = self
            .trust
            .lock()
            .map_err(|_| AppError::Runtime("JSON schema trust is unavailable".to_owned()))?;
        let mut next = current.clone();
        match scope {
            JsonSchemaTrustScope::Uri => {
                next.uris
                    .remove(&normalized_remote_url(&normalize_remote_uri(value)?));
            }
            JsonSchemaTrustScope::Origin => {
                next.origins.remove(&normalize_origin(value)?);
            }
        }
        write_trust(&self.trust_path, &next)?;
        *current = next;
        Ok(current.snapshot())
    }

    pub async fn resolve(
        &self,
        schema_uri: String,
        document_path: Option<String>,
        workspace_root: Option<String>,
    ) -> AppResult<JsonSchemaResolution> {
        let result = self
            .resolve_graph(
                &schema_uri,
                document_path.as_deref(),
                workspace_root.as_deref(),
            )
            .await;
        match result {
            Ok(schemas) => Ok(JsonSchemaResolution::Resolved { schemas }),
            Err(ResolutionFailure::TrustRequired { uri, origin }) => {
                Ok(JsonSchemaResolution::TrustRequired { uri, origin })
            }
            Err(ResolutionFailure::Application(error)) => Err(error),
        }
    }

    async fn resolve_graph(
        &self,
        schema_reference: &str,
        document_path: Option<&str>,
        workspace_root: Option<&str>,
    ) -> Result<Vec<ResolvedJsonSchema>, ResolutionFailure> {
        let root = resolve_root_reference(schema_reference, document_path)?;
        let workspace_root = workspace_root.map(str::to_owned);
        let document_path = document_path.map(str::to_owned);
        let allowed_local_root =
            run_schema_io(move || local_scope(workspace_root.as_deref(), document_path.as_deref()))
                .await?;
        let mut queue = VecDeque::from([root]);
        let mut visited = BTreeSet::new();
        let mut schemas = Vec::new();
        let mut total_bytes = 0usize;

        while let Some(url) = queue.pop_front() {
            let resource = resource_url(url);
            let identifier = resource.to_string();
            if !visited.insert(identifier.clone()) {
                continue;
            }
            if visited.len() > MAX_SCHEMA_GRAPH_ENTRIES {
                return Err(AppError::JsonSchema(format!(
                    "schema graph exceeds the {MAX_SCHEMA_GRAPH_ENTRIES}-document safety limit"
                ))
                .into());
            }

            let loaded = self
                .load_schema(&resource, allowed_local_root.as_deref())
                .await?;
            total_bytes = total_bytes.saturating_add(loaded.bytes);
            if total_bytes > MAX_SCHEMA_GRAPH_BYTES {
                return Err(AppError::JsonSchema(
                    "schema graph exceeds the 16 MiB safety limit".to_owned(),
                )
                .into());
            }

            for dependency in collect_external_references(&loaded.schema, &resource)? {
                queue.push_back(dependency);
            }
            schemas.push(ResolvedJsonSchema {
                uri: identifier,
                schema: loaded.schema,
            });
        }

        Ok(schemas)
    }

    async fn load_schema(
        &self,
        location: &Url,
        allowed_local_root: Option<&Path>,
    ) -> Result<LoadedSchema, ResolutionFailure> {
        match location.scheme() {
            "file" => self.load_local_schema(location, allowed_local_root).await,
            "https" => self.load_remote_schema(location).await,
            scheme => Err(AppError::JsonSchema(format!(
                "schema protocol '{scheme}' is not supported"
            ))
            .into()),
        }
    }

    async fn load_local_schema(
        &self,
        location: &Url,
        allowed_local_root: Option<&Path>,
    ) -> Result<LoadedSchema, ResolutionFailure> {
        let path = location.to_file_path().map_err(|()| {
            AppError::JsonSchema(format!("{} is not a valid local schema URI", location))
        })?;
        let allowed_root = allowed_local_root.ok_or_else(|| {
            AppError::JsonSchema("local schemas require a saved document".to_owned())
        })?;
        let allowed_root = allowed_root.to_path_buf();
        let (path, stamp) =
            run_schema_io(move || inspect_local_schema(&path, &allowed_root)).await?;
        let key = location.to_string();
        if let Some(cached) = self.cached_schema(&key)?
            && matches!(cached.validator, CacheValidator::Local(current) if current == stamp)
        {
            return Ok(cached.into());
        }

        let bytes = run_schema_io(move || {
            fs::read(&path).map_err(|error| {
                AppError::io(format!("could not read schema {}", path.display()), error)
            })
        })
        .await?;
        let schema = parse_schema(&bytes, &key)?;
        let loaded = CachedSchema {
            bytes: bytes.len(),
            schema,
            loaded_at: Instant::now(),
            validator: CacheValidator::Local(stamp),
        };
        self.cache_schema(key, loaded.clone())?;
        Ok(loaded.into())
    }

    async fn load_remote_schema(&self, requested: &Url) -> Result<LoadedSchema, ResolutionFailure> {
        validate_remote_url(requested)?;
        self.require_trust(requested)?;
        let key = normalized_remote_url(requested);
        let cached = self.cached_schema(&key)?;
        if let Some(current) = &cached
            && current.loaded_at.elapsed() < REMOTE_CACHE_TTL
        {
            return Ok(current.clone().into());
        }

        let mut current_url = requested.clone();
        for redirect_count in 0..=MAX_REDIRECTS {
            validate_remote_url(&current_url)?;
            self.require_trust(&current_url)?;
            validate_public_destination(&current_url).await?;

            let mut request = self.client.get(current_url.clone());
            if redirect_count == 0
                && let Some(CachedSchema {
                    validator:
                        CacheValidator::Remote {
                            etag,
                            last_modified,
                            retrieval_uri,
                        },
                    ..
                }) = &cached
                && retrieval_uri == current_url.as_str()
            {
                if let Some(etag) = etag {
                    request = request.header(IF_NONE_MATCH, etag);
                }
                if let Some(last_modified) = last_modified {
                    request = request.header(IF_MODIFIED_SINCE, last_modified);
                }
            }

            let mut response = request.send().await.map_err(|error| {
                AppError::JsonSchema(format!("request to {current_url} failed: {error}"))
            })?;
            if response.status() == StatusCode::NOT_MODIFIED {
                return self
                    .refresh_cached_schema(&key)?
                    .map(Into::into)
                    .ok_or_else(|| {
                        AppError::JsonSchema(
                            "schema server returned 304 without a cached response".to_owned(),
                        )
                        .into()
                    });
            }
            if response.status().is_redirection() {
                if redirect_count == MAX_REDIRECTS {
                    return Err(AppError::JsonSchema(format!(
                        "schema request exceeded the {MAX_REDIRECTS}-redirect safety limit"
                    ))
                    .into());
                }
                let location = response
                    .headers()
                    .get(LOCATION)
                    .ok_or_else(|| {
                        AppError::JsonSchema(format!(
                            "schema server {current_url} returned a redirect without a location"
                        ))
                    })?
                    .to_str()
                    .map_err(|error| {
                        AppError::JsonSchema(format!(
                            "invalid redirect from {current_url}: {error}"
                        ))
                    })?;
                current_url = current_url.join(location).map_err(|error| {
                    AppError::JsonSchema(format!("invalid redirect from {current_url}: {error}"))
                })?;
                continue;
            }
            if !response.status().is_success() {
                return Err(AppError::JsonSchema(format!(
                    "schema server {current_url} returned HTTP {}",
                    response.status()
                ))
                .into());
            }
            if response
                .content_length()
                .is_some_and(|length| length > MAX_SCHEMA_BYTES as u64)
            {
                return Err(AppError::JsonSchema(
                    "schema exceeds the 4 MiB safety limit".to_owned(),
                )
                .into());
            }

            let etag = header_value(response.headers(), ETAG);
            let last_modified = header_value(response.headers(), LAST_MODIFIED);
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|error| {
                AppError::JsonSchema(format!("could not read schema from {current_url}: {error}"))
            })? {
                if bytes.len().saturating_add(chunk.len()) > MAX_SCHEMA_BYTES {
                    return Err(AppError::JsonSchema(
                        "schema exceeds the 4 MiB safety limit".to_owned(),
                    )
                    .into());
                }
                bytes.extend_from_slice(&chunk);
            }
            let mut schema = parse_schema(&bytes, current_url.as_str())?;
            if current_url != *requested {
                apply_redirect_base(&mut schema, &current_url);
            }
            let loaded = CachedSchema {
                bytes: bytes.len(),
                schema,
                loaded_at: Instant::now(),
                validator: CacheValidator::Remote {
                    etag,
                    last_modified,
                    retrieval_uri: current_url.to_string(),
                },
            };
            self.cache_schema(key, loaded.clone())?;
            return Ok(loaded.into());
        }

        Err(AppError::JsonSchema("schema redirect resolution failed".to_owned()).into())
    }

    fn require_trust(&self, uri: &Url) -> Result<(), ResolutionFailure> {
        let trusted = self
            .trust
            .lock()
            .map_err(|_| AppError::Runtime("JSON schema trust is unavailable".to_owned()))?
            .is_trusted(uri);
        if trusted {
            Ok(())
        } else {
            Err(ResolutionFailure::TrustRequired {
                uri: normalized_remote_url(uri),
                origin: origin_of(uri),
            })
        }
    }

    fn cached_schema(&self, key: &str) -> AppResult<Option<CachedSchema>> {
        self.cache
            .lock()
            .map(|mut cache| cache.get(key))
            .map_err(|_| AppError::Runtime("JSON schema cache is unavailable".to_owned()))
    }

    fn refresh_cached_schema(&self, key: &str) -> AppResult<Option<CachedSchema>> {
        self.cache
            .lock()
            .map(|mut cache| cache.refresh(key))
            .map_err(|_| AppError::Runtime("JSON schema cache is unavailable".to_owned()))
    }

    fn cache_schema(&self, key: String, schema: CachedSchema) -> AppResult<()> {
        self.cache
            .lock()
            .map(|mut cache| cache.insert(key, schema))
            .map_err(|_| AppError::Runtime("JSON schema cache is unavailable".to_owned()))
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JsonSchemaTrustScope {
    Uri,
    Origin,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonSchemaTrustSettings {
    built_in_origins: Vec<String>,
    origins: Vec<String>,
    uris: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum JsonSchemaResolution {
    Resolved { schemas: Vec<ResolvedJsonSchema> },
    TrustRequired { uri: String, origin: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedJsonSchema {
    uri: String,
    schema: Value,
}

#[derive(Debug)]
struct LoadedSchema {
    schema: Value,
    bytes: usize,
}

impl From<CachedSchema> for LoadedSchema {
    fn from(cached: CachedSchema) -> Self {
        Self {
            schema: cached.schema,
            bytes: cached.bytes,
        }
    }
}

#[derive(Debug)]
enum ResolutionFailure {
    Application(AppError),
    TrustRequired { uri: String, origin: String },
}

impl From<AppError> for ResolutionFailure {
    fn from(error: AppError) -> Self {
        Self::Application(error)
    }
}

fn resolve_root_reference(reference: &str, document_path: Option<&str>) -> AppResult<Url> {
    let trimmed = reference.trim();
    if trimmed.is_empty() {
        return Err(AppError::JsonSchema("schema URI is empty".to_owned()));
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Url::from_file_path(path).map_err(|()| {
            AppError::JsonSchema(format!("{} is not a valid schema path", path.display()))
        });
    }
    if let Ok(url) = Url::parse(trimmed) {
        return Ok(url);
    }
    let document_path = document_path.ok_or_else(|| {
        AppError::JsonSchema("relative schemas require a saved document".to_owned())
    })?;
    let document_url = Url::from_file_path(document_path).map_err(|()| {
        AppError::JsonSchema(format!("{document_path} is not a valid document path"))
    })?;
    document_url.join(trimmed).map_err(|error| {
        AppError::JsonSchema(format!("could not resolve schema URI '{trimmed}': {error}"))
    })
}

fn local_scope(
    workspace_root: Option<&str>,
    document_path: Option<&str>,
) -> AppResult<Option<PathBuf>> {
    let candidate = workspace_root.map(PathBuf::from).or_else(|| {
        document_path
            .map(PathBuf::from)
            .and_then(|path| path.parent().map(Path::to_path_buf))
    });
    candidate
        .map(|path| {
            fs::canonicalize(&path).map_err(|error| {
                AppError::io(
                    format!("could not resolve schema scope {}", path.display()),
                    error,
                )
            })
        })
        .transpose()
}

fn canonicalize_schema_path(path: &Path, allowed_root: &Path) -> AppResult<PathBuf> {
    let canonical = fs::canonicalize(path).map_err(|error| {
        AppError::io(
            format!("could not resolve schema {}", path.display()),
            error,
        )
    })?;
    if !canonical.starts_with(allowed_root) {
        return Err(AppError::JsonSchema(format!(
            "local schema {} is outside the active workspace",
            canonical.display()
        )));
    }
    Ok(canonical)
}

fn inspect_local_schema(path: &Path, allowed_root: &Path) -> AppResult<(PathBuf, FileStamp)> {
    let path = canonicalize_schema_path(path, allowed_root)?;
    let metadata = fs::metadata(&path).map_err(|error| {
        AppError::io(
            format!("could not inspect schema {}", path.display()),
            error,
        )
    })?;
    if metadata.len() > MAX_SCHEMA_BYTES as u64 {
        return Err(AppError::JsonSchema(
            "schema exceeds the 4 MiB safety limit".to_owned(),
        ));
    }
    let stamp = FileStamp {
        length: metadata.len(),
        modified: metadata.modified().ok(),
    };
    Ok((path, stamp))
}

async fn run_schema_io<T, Operation>(operation: Operation) -> Result<T, ResolutionFailure>
where
    T: Send + 'static,
    Operation: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| AppError::Runtime(error.to_string()))?
        .map_err(ResolutionFailure::from)
}

fn collect_external_references(schema: &Value, retrieval_uri: &Url) -> AppResult<Vec<Url>> {
    let mut local_resources = BTreeSet::from([resource_url(retrieval_uri.clone())]);
    collect_declared_resources(schema, retrieval_uri, &mut local_resources)?;
    let mut references = BTreeSet::new();
    collect_references(
        schema,
        retrieval_uri,
        retrieval_uri,
        &local_resources,
        &mut references,
    )?;
    Ok(references.into_iter().collect())
}

fn collect_declared_resources(
    value: &Value,
    base: &Url,
    resources: &mut BTreeSet<Url>,
) -> AppResult<()> {
    match value {
        Value::Object(object) => {
            let object_base = schema_object_base(object, base)?;
            resources.insert(resource_url(object_base.clone()));
            for child in object.values() {
                collect_declared_resources(child, &object_base, resources)?;
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_declared_resources(item, base, resources)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn collect_references(
    value: &Value,
    base: &Url,
    retrieval_uri: &Url,
    local_resources: &BTreeSet<Url>,
    references: &mut BTreeSet<Url>,
) -> AppResult<()> {
    match value {
        Value::Object(object) => {
            let object_base = schema_object_base(object, base)?;

            for keyword in ["$ref", "$dynamicRef", "$recursiveRef"] {
                if let Some(reference) = object.get(keyword).and_then(Value::as_str) {
                    let target = object_base.join(reference).map_err(|error| {
                        AppError::JsonSchema(format!(
                            "schema contains invalid {keyword} '{reference}': {error}"
                        ))
                    })?;
                    let resource = resource_url(target);
                    if !local_resources.contains(&resource) {
                        match resource.scheme() {
                            "file" if retrieval_uri.scheme() == "https" => {
                                return Err(AppError::JsonSchema(
                                    "remote schemas cannot reference local files".to_owned(),
                                ));
                            }
                            "file" | "https" | "http" => {
                                references.insert(resource);
                            }
                            _ => {}
                        }
                    }
                }
            }

            for child in object.values() {
                collect_references(
                    child,
                    &object_base,
                    retrieval_uri,
                    local_resources,
                    references,
                )?;
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_references(item, base, retrieval_uri, local_resources, references)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn schema_object_base(object: &serde_json::Map<String, Value>, base: &Url) -> AppResult<Url> {
    object
        .get("$id")
        .and_then(Value::as_str)
        .map(|identifier| {
            base.join(identifier).map_err(|error| {
                AppError::JsonSchema(format!(
                    "schema contains invalid $id '{identifier}': {error}"
                ))
            })
        })
        .transpose()
        .map(|identifier| identifier.unwrap_or_else(|| base.clone()))
}

fn parse_schema(bytes: &[u8], source: &str) -> AppResult<Value> {
    let schema = serde_json::from_slice::<Value>(bytes).map_err(|error| {
        AppError::JsonSchema(format!("schema {source} is not valid JSON: {error}"))
    })?;
    if !schema.is_object() && !schema.is_boolean() {
        return Err(AppError::JsonSchema(format!(
            "schema {source} must be a JSON object or boolean"
        )));
    }
    Ok(schema)
}

fn apply_redirect_base(schema: &mut Value, retrieval_uri: &Url) {
    if let Value::Object(object) = schema
        && !object.contains_key("$id")
        && !object.contains_key("id")
    {
        object.insert("$id".to_owned(), Value::String(retrieval_uri.to_string()));
    }
}

fn validate_remote_url(url: &Url) -> AppResult<()> {
    if url.scheme() != "https" {
        return Err(AppError::JsonSchema(
            "remote schemas must use HTTPS".to_owned(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::JsonSchema(
            "schema URIs cannot contain credentials".to_owned(),
        ));
    }
    let host = url
        .host()
        .ok_or_else(|| AppError::JsonSchema(format!("schema URI {url} does not contain a host")))?;
    if let Host::Domain(domain) = host {
        let normalized = domain.trim_end_matches('.').to_ascii_lowercase();
        if normalized == "localhost"
            || normalized.ends_with(".localhost")
            || normalized.ends_with(".local")
        {
            return Err(AppError::JsonSchema(
                "remote schemas cannot target local hostnames".to_owned(),
            ));
        }
    }
    Ok(())
}

async fn validate_public_destination(url: &Url) -> Result<(), ResolutionFailure> {
    let addresses = match url.host() {
        Some(Host::Ipv4(address)) => vec![IpAddr::V4(address)],
        Some(Host::Ipv6(address)) => vec![IpAddr::V6(address)],
        Some(Host::Domain(domain)) => {
            let domain = domain.to_owned();
            let port = url.port_or_known_default().ok_or_else(|| {
                AppError::JsonSchema(format!("schema URI {url} does not contain a valid port"))
            })?;
            tauri::async_runtime::spawn_blocking(move || {
                (domain.as_str(), port)
                    .to_socket_addrs()
                    .map(|addresses| addresses.map(|address| address.ip()).collect::<Vec<_>>())
            })
            .await
            .map_err(|error| AppError::Runtime(error.to_string()))?
            .map_err(|error| {
                AppError::JsonSchema(format!("could not resolve schema host: {error}"))
            })?
        }
        None => {
            return Err(
                AppError::JsonSchema(format!("schema URI {url} does not contain a host")).into(),
            );
        }
    };
    if addresses.is_empty() {
        return Err(AppError::JsonSchema("schema host resolved to no addresses".to_owned()).into());
    }
    if addresses.iter().any(|address| !is_public_address(*address)) {
        return Err(AppError::JsonSchema(
            "remote schemas cannot target private or reserved network addresses".to_owned(),
        )
        .into());
    }
    Ok(())
}

fn is_public_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let [first, second, third, _] = address.octets();
    !(address.is_private()
        || address.is_loopback()
        || address.is_link_local()
        || address.is_broadcast()
        || address.is_documentation()
        || address.is_unspecified()
        || address.is_multicast()
        || first == 0
        || (first == 100 && (64..=127).contains(&second))
        || (first == 192 && second == 0 && third == 0)
        || (first == 198 && (18..=19).contains(&second))
        || first >= 240)
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    if let Some(ipv4) = address.to_ipv4_mapped() {
        return is_public_ipv4(ipv4);
    }
    let octets = address.octets();
    !(address.is_loopback()
        || address.is_unspecified()
        || address.is_multicast()
        || address.is_unique_local()
        || address.is_unicast_link_local()
        || octets[..4] == [0x20, 0x01, 0x0d, 0xb8])
}

fn resource_url(mut url: Url) -> Url {
    url.set_fragment(None);
    url
}

fn normalized_remote_url(url: &Url) -> String {
    resource_url(url.clone()).to_string()
}

fn origin_of(url: &Url) -> String {
    url.origin().ascii_serialization()
}

fn normalize_remote_uri(uri: &str) -> AppResult<Url> {
    let url = Url::parse(uri)
        .map_err(|error| AppError::JsonSchema(format!("invalid schema URI '{uri}': {error}")))?;
    validate_remote_url(&url)?;
    Ok(resource_url(url))
}

fn normalize_origin(origin: &str) -> AppResult<String> {
    let url = normalize_remote_uri(origin)?;
    if url.path() != "/" || url.query().is_some() {
        return Err(AppError::JsonSchema(format!(
            "'{origin}' is not a schema origin"
        )));
    }
    Ok(origin_of(&url))
}

fn header_value(
    headers: &reqwest::header::HeaderMap,
    name: reqwest::header::HeaderName,
) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

fn read_trust(path: &Path) -> AppResult<TrustDocument> {
    if !path.exists() {
        return Ok(TrustDocument::default());
    }
    let metadata = fs::metadata(path)
        .map_err(|error| AppError::io(format!("could not inspect {}", path.display()), error))?;
    if metadata.len() > MAX_TRUST_FILE_BYTES {
        return Err(AppError::InvalidSettings(
            "JSON schema trust exceeds the 64 KiB safety limit".to_owned(),
        ));
    }
    let source = fs::read_to_string(path)
        .map_err(|error| AppError::io(format!("could not read {}", path.display()), error))?;
    serde_json::from_str::<TrustDocument>(&source)
        .map_err(|error| {
            AppError::InvalidSettings(format!("invalid JSON schema trust structure: {error}"))
        })?
        .validate()
}

fn write_trust(path: &Path, trust: &TrustDocument) -> AppResult<()> {
    let parent = path.parent().ok_or_else(|| {
        AppError::InvalidPath(format!("{} has no parent directory", path.display()))
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        AppError::io(
            format!(
                "could not create schema trust directory {}",
                parent.display()
            ),
            error,
        )
    })?;
    let serialized = serde_json::to_vec_pretty(trust).map_err(|error| {
        AppError::InvalidSettings(format!("could not serialize JSON schema trust: {error}"))
    })?;
    if serialized.len() as u64 > MAX_TRUST_FILE_BYTES {
        return Err(AppError::InvalidSettings(
            "JSON schema trust exceeds the 64 KiB safety limit".to_owned(),
        ));
    }
    let mut temporary = NamedTempFile::new_in(parent).map_err(|error| {
        AppError::io(
            format!(
                "could not create a temporary schema trust file in {}",
                parent.display()
            ),
            error,
        )
    })?;
    temporary
        .write_all(&serialized)
        .and_then(|()| temporary.write_all(b"\n"))
        .map_err(|error| AppError::io("could not write JSON schema trust", error))?;
    temporary
        .as_file_mut()
        .sync_all()
        .map_err(|error| AppError::io("could not flush JSON schema trust", error))?;
    temporary.persist(path).map_err(|error| {
        AppError::io(
            format!("could not atomically replace {}", path.display()),
            error.error,
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeSet, error::Error, net::IpAddr, str::FromStr};

    use serde_json::json;
    use tempfile::tempdir;
    use url::Url;

    use super::{
        TrustDocument, apply_redirect_base, build_http_client, collect_external_references,
        is_public_address, normalize_origin, read_trust, resolve_root_reference, write_trust,
    };

    type TestResult = Result<(), Box<dyn Error>>;

    #[test]
    fn initializes_the_https_client_with_a_crypto_provider() -> TestResult {
        build_http_client()?;
        Ok(())
    }

    #[test]
    fn trusts_biome_as_a_built_in_origin() -> TestResult {
        let trust = TrustDocument::default();
        let uri = Url::parse("https://biomejs.dev/schemas/2.5.7/schema.json")?;

        assert!(trust.is_trusted(&uri));
        Ok(())
    }

    #[test]
    fn normalizes_origins_without_accepting_paths() -> TestResult {
        let normalized = normalize_origin("https://example.com")?;
        assert_eq!(normalized, "https://example.com");
        assert!(normalize_origin("https://example.com/schema.json").is_err());
        Ok(())
    }

    #[test]
    fn resolves_relative_schema_against_the_document() -> TestResult {
        let document = std::env::temp_dir().join("workspace").join("project.json");
        let document = document.to_string_lossy();
        let resolved =
            resolve_root_reference("./schemas/project.schema.json", Some(document.as_ref()))?;

        assert_eq!(resolved.scheme(), "file");
        assert!(
            resolved
                .path()
                .ends_with("/workspace/schemas/project.schema.json")
        );
        Ok(())
    }

    #[test]
    fn collects_transitive_references_using_nested_ids() -> TestResult {
        let source = json!({
            "$id": "https://example.com/schemas/root.json",
            "properties": {
                "item": {
                    "$id": "nested/",
                    "$ref": "item.json#/$defs/value"
                }
            },
            "$defs": { "local": { "$ref": "#/$defs/local" } }
        });
        let retrieval_uri = Url::parse("https://example.com/schemas/root.json")?;
        let references = collect_external_references(&source, &retrieval_uri)?
            .into_iter()
            .map(|uri| uri.to_string())
            .collect::<BTreeSet<_>>();

        assert_eq!(
            references,
            BTreeSet::from(["https://example.com/schemas/nested/item.json".to_owned()])
        );
        Ok(())
    }

    #[test]
    fn does_not_fetch_resources_declared_inside_the_schema() -> TestResult {
        let source = json!({
            "$id": "https://schemas.example.com/project.json",
            "$defs": { "value": { "type": "string" } },
            "$ref": "#/$defs/value"
        });
        let retrieval_uri = Url::parse("https://cdn.example.com/project.json")?;

        let references = collect_external_references(&source, &retrieval_uri)?;

        assert!(references.is_empty());
        Ok(())
    }

    #[test]
    fn records_the_final_base_for_redirected_schemas() -> TestResult {
        let mut schema = json!({ "$ref": "definitions.json" });
        let retrieval_uri = Url::parse("https://cdn.example.com/v2/schema.json")?;

        apply_redirect_base(&mut schema, &retrieval_uri);

        assert_eq!(schema["$id"], retrieval_uri.as_str());
        Ok(())
    }

    #[test]
    fn blocks_private_and_reserved_network_addresses() -> TestResult {
        for value in ["127.0.0.1", "10.0.0.1", "169.254.1.1", "::1", "fc00::1"] {
            let address = IpAddr::from_str(value)?;
            assert!(!is_public_address(address));
        }
        assert!(is_public_address(IpAddr::from_str("1.1.1.1")?));
        Ok(())
    }

    #[test]
    fn persists_and_restores_explicit_trust() -> TestResult {
        let directory = tempdir()?;
        let path = directory.path().join("json-schema-trust.json");
        let trust = TrustDocument {
            origins: BTreeSet::from(["https://example.com".to_owned()]),
            uris: BTreeSet::from(["https://schemas.example.net/project.json".to_owned()]),
            ..TrustDocument::default()
        };

        write_trust(&path, &trust)?;
        let restored = read_trust(&path)?;

        assert_eq!(restored.origins, trust.origins);
        assert_eq!(restored.uris, trust.uris);

        let updated = TrustDocument {
            origins: BTreeSet::from(["https://updated.example.com".to_owned()]),
            ..TrustDocument::default()
        };
        write_trust(&path, &updated)?;
        let restored = read_trust(&path)?;

        assert_eq!(restored.origins, updated.origins);
        assert!(restored.uris.is_empty());
        Ok(())
    }
}
