use std::{
    collections::BTreeMap,
    net::{SocketAddr, ToSocketAddrs},
    str::FromStr,
    sync::Arc,
    time::Duration,
};

use reqwest::{
    Client, Method,
    header::{AUTHORIZATION, CONTENT_LENGTH, HeaderMap, HeaderName, HeaderValue, LOCATION},
    redirect::Policy,
};
use serde_json::{Value, json};
use sideral_extension_core::{ExtensionManifest, NetworkMethod};
use url::{Host, Url};

use super::{Cancellation, CapabilityBroker, NetworkRequestPayload, run_blocking};
pub(super) use crate::network_security::is_public_ipv4;
use crate::{
    network_security::{is_public_address, is_public_ipv6},
    sideral_extensions::error::ExtensionError,
};

const MAX_NETWORK_REQUEST_BODY_BYTES: usize = 1024 * 1024;
const DEFAULT_NETWORK_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_NETWORK_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const NETWORK_DEADLINE: Duration = Duration::from_secs(30);
const MAX_NETWORK_REDIRECTS: usize = 5;
const MAX_NETWORK_HEADERS: usize = 64;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_NETWORK_RESPONSE_HEADERS: usize = 128;
const MAX_RESPONSE_HEADER_BYTES: usize = 64 * 1024;

impl CapabilityBroker {
    pub(super) async fn network_request(
        &self,
        manifest: &ExtensionManifest,
        payload: NetworkRequestPayload,
        cancellation: Arc<Cancellation>,
    ) -> Result<Value, ExtensionError> {
        let _network_slot = self
            .shared
            .network_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                ExtensionError::Conflict("extension network pool is at capacity".to_owned())
            })?;
        let method = Method::from_bytes(payload.method.as_bytes()).map_err(|error| {
            ExtensionError::InvalidRequest(format!("invalid HTTP method: {error}"))
        })?;
        if !matches!(
            method,
            Method::GET | Method::POST | Method::PUT | Method::PATCH | Method::DELETE
        ) {
            return Err(ExtensionError::InvalidRequest(
                "HTTP method is unsupported".to_owned(),
            ));
        }
        if payload
            .body
            .as_ref()
            .is_some_and(|body| body.len() > MAX_NETWORK_REQUEST_BODY_BYTES)
        {
            return Err(ExtensionError::InvalidRequest(format!(
                "network request body exceeds {MAX_NETWORK_REQUEST_BODY_BYTES} bytes"
            )));
        }
        let maximum_response_bytes = payload
            .maximum_response_bytes
            .unwrap_or(DEFAULT_NETWORK_RESPONSE_BYTES);
        if !(1..=MAX_NETWORK_RESPONSE_BYTES).contains(&maximum_response_bytes) {
            return Err(ExtensionError::InvalidRequest(format!(
                "maximum response size must be between 1 and {MAX_NETWORK_RESPONSE_BYTES} bytes"
            )));
        }
        let headers = request_headers(&payload.headers)?;
        let operation = self.network_request_inner(
            manifest,
            payload,
            method,
            headers,
            maximum_response_bytes,
            cancellation.clone(),
        );
        tokio::select! {
            () = cancellation.cancelled() => Err(ExtensionError::Cancelled),
            result = tokio::time::timeout(NETWORK_DEADLINE, operation) => {
                result.map_err(|_| ExtensionError::DeadlineExceeded)?
            }
        }
    }

    async fn network_request_inner(
        &self,
        manifest: &ExtensionManifest,
        payload: NetworkRequestPayload,
        method: Method,
        headers: HeaderMap,
        maximum_response_bytes: usize,
        cancellation: Arc<Cancellation>,
    ) -> Result<Value, ExtensionError> {
        let mut current_url = Url::parse(&payload.url)
            .map_err(|error| ExtensionError::InvalidRequest(format!("invalid URL: {error}")))?;
        let mut headers = headers;
        for redirect_count in 0..=MAX_NETWORK_REDIRECTS {
            validate_network_permission(manifest, &current_url, &method)?;
            let resolution = resolve_network_destination(&current_url).await?;
            let client = match resolution {
                Some((domain, addresses)) => network_client_builder()
                    .resolve_to_addrs(&domain, &addresses)
                    .build()
                    .map_err(|error| {
                        ExtensionError::Runtime(format!(
                            "could not create a pinned extension HTTP client: {error}"
                        ))
                    })?,
                None => self.shared.network_client.clone(),
            };
            let mut builder = client
                .request(method.clone(), current_url.clone())
                .headers(headers.clone());
            if let Some(body) = payload.body.clone() {
                builder = builder.body(body);
            }
            let mut response = tokio::select! {
                () = cancellation.cancelled() => return Err(ExtensionError::Cancelled),
                result = builder.send() => result.map_err(|error| {
                    ExtensionError::Runtime(format!("extension network request failed: {error}"))
                })?,
            };
            if response.status().is_redirection() {
                if !matches!(method, Method::GET) {
                    return Err(ExtensionError::PermissionDenied(
                        "redirects are disabled for mutating extension requests".to_owned(),
                    ));
                }
                if redirect_count == MAX_NETWORK_REDIRECTS {
                    return Err(ExtensionError::InvalidRequest(format!(
                        "network request exceeded {MAX_NETWORK_REDIRECTS} redirects"
                    )));
                }
                let location = response
                    .headers()
                    .get(LOCATION)
                    .ok_or_else(|| {
                        ExtensionError::InvalidRequest(
                            "network redirect did not include a location".to_owned(),
                        )
                    })?
                    .to_str()
                    .map_err(|_| {
                        ExtensionError::InvalidRequest(
                            "network redirect location is not valid text".to_owned(),
                        )
                    })?;
                let redirected_url = current_url.join(location).map_err(|error| {
                    ExtensionError::InvalidRequest(format!("invalid network redirect: {error}"))
                })?;
                if redirected_url.origin() != current_url.origin() {
                    headers.remove(AUTHORIZATION);
                }
                current_url = redirected_url;
                continue;
            }
            let status = response.status().as_u16();
            if response
                .headers()
                .get(CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<usize>().ok())
                .is_some_and(|length| length > maximum_response_bytes)
            {
                return Err(ExtensionError::InvalidRequest(format!(
                    "network response exceeds {maximum_response_bytes} bytes"
                )));
            }
            let response_headers = response_headers(response.headers())?;
            let mut body = Vec::new();
            loop {
                let chunk = tokio::select! {
                    () = cancellation.cancelled() => return Err(ExtensionError::Cancelled),
                    chunk = response.chunk() => chunk.map_err(|error| {
                        ExtensionError::Runtime(format!("could not read network response: {error}"))
                    })?,
                };
                let Some(chunk) = chunk else {
                    break;
                };
                if body.len().saturating_add(chunk.len()) > maximum_response_bytes {
                    return Err(ExtensionError::InvalidRequest(format!(
                        "network response exceeds {maximum_response_bytes} bytes"
                    )));
                }
                body.extend_from_slice(&chunk);
            }
            let body = String::from_utf8(body).map_err(|_| {
                ExtensionError::InvalidRequest("network response is not UTF-8".to_owned())
            })?;
            return Ok(json!({
                "status": status,
                "headers": response_headers,
                "body": body,
            }));
        }
        Err(ExtensionError::Runtime(
            "network redirect resolution failed".to_owned(),
        ))
    }
}

fn validate_network_permission(
    manifest: &ExtensionManifest,
    url: &Url,
    method: &Method,
) -> Result<(), ExtensionError> {
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(ExtensionError::InvalidRequest(
            "network URLs cannot contain credentials or fragments".to_owned(),
        ));
    }
    let origin = url.origin().ascii_serialization();
    let permitted_method = match *method {
        Method::GET => NetworkMethod::GET,
        Method::POST => NetworkMethod::POST,
        Method::PUT => NetworkMethod::PUT,
        Method::PATCH => NetworkMethod::PATCH,
        Method::DELETE => NetworkMethod::DELETE,
        _ => {
            return Err(ExtensionError::InvalidRequest(
                "HTTP method is unsupported".to_owned(),
            ));
        }
    };
    let allowed = manifest.permissions.network.iter().any(|permission| {
        Url::parse(&permission.origin)
            .is_ok_and(|allowed| allowed.origin().ascii_serialization() == origin)
            && permission.methods.contains(&permitted_method)
    });
    if allowed {
        Ok(())
    } else {
        Err(ExtensionError::PermissionDenied(format!(
            "extension {} did not declare {method} access to {origin}",
            manifest.id
        )))
    }
}

pub(super) fn network_client_builder() -> reqwest::ClientBuilder {
    Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(NETWORK_DEADLINE)
        .user_agent("Sideral-Extension-Host/1")
}

async fn resolve_network_destination(
    url: &Url,
) -> Result<Option<(String, Vec<SocketAddr>)>, ExtensionError> {
    let host = url
        .host()
        .ok_or_else(|| ExtensionError::InvalidRequest(format!("network URL {url} has no host")))?;
    let port = url.port_or_known_default().ok_or_else(|| {
        ExtensionError::InvalidRequest(format!("network URL {url} has no valid port"))
    })?;
    match host {
        Host::Ipv4(address) => {
            if !address.is_loopback() && !is_public_ipv4(address) {
                return Err(ExtensionError::PermissionDenied(
                    "network destination is a private or reserved address".to_owned(),
                ));
            }
            Ok(None)
        }
        Host::Ipv6(address) => {
            if !address.is_loopback() && !is_public_ipv6(address) {
                return Err(ExtensionError::PermissionDenied(
                    "network destination is a private or reserved address".to_owned(),
                ));
            }
            Ok(None)
        }
        Host::Domain(domain) => {
            let normalized = domain.trim_end_matches('.').to_ascii_lowercase();
            if normalized.ends_with(".localhost") || normalized.ends_with(".local") {
                return Err(ExtensionError::PermissionDenied(
                    "network requests cannot target local hostnames".to_owned(),
                ));
            }
            let domain = domain.to_owned();
            let lookup_domain = domain.clone();
            let mut addresses = run_blocking(move || {
                (lookup_domain.as_str(), port)
                    .to_socket_addrs()
                    .map(|addresses| addresses.collect::<Vec<_>>())
                    .map_err(|error| {
                        ExtensionError::Runtime(format!("could not resolve network host: {error}"))
                    })
            })
            .await?;
            addresses.sort_unstable();
            addresses.dedup();
            let valid = if normalized == "localhost" {
                addresses.iter().all(|address| address.ip().is_loopback())
            } else {
                addresses
                    .iter()
                    .all(|address| is_public_address(address.ip()))
            };
            if addresses.is_empty() || !valid {
                return Err(ExtensionError::PermissionDenied(
                    "network destination resolved to a private or reserved address".to_owned(),
                ));
            }
            Ok(Some((domain, addresses)))
        }
    }
}

fn response_headers(headers: &HeaderMap) -> Result<BTreeMap<String, String>, ExtensionError> {
    if headers.len() > MAX_NETWORK_RESPONSE_HEADERS {
        return Err(ExtensionError::InvalidRequest(format!(
            "network response exceeds {MAX_NETWORK_RESPONSE_HEADERS} headers"
        )));
    }
    let mut total_bytes = 0_usize;
    let mut result = BTreeMap::new();
    for (name, value) in headers {
        total_bytes = total_bytes
            .saturating_add(name.as_str().len())
            .saturating_add(value.as_bytes().len());
        if total_bytes > MAX_RESPONSE_HEADER_BYTES {
            return Err(ExtensionError::InvalidRequest(format!(
                "network response headers exceed {MAX_RESPONSE_HEADER_BYTES} bytes"
            )));
        }
        if let Ok(value) = value.to_str() {
            result.insert(name.as_str().to_owned(), value.to_owned());
        }
    }
    Ok(result)
}

fn request_headers(headers: &BTreeMap<String, String>) -> Result<HeaderMap, ExtensionError> {
    if headers.len() > MAX_NETWORK_HEADERS {
        return Err(ExtensionError::InvalidRequest(format!(
            "network request exceeds {MAX_NETWORK_HEADERS} headers"
        )));
    }
    let mut result = HeaderMap::new();
    let mut total_bytes = 0_usize;
    for (name, value) in headers {
        total_bytes = total_bytes
            .saturating_add(name.len())
            .saturating_add(value.len());
        if total_bytes > MAX_HEADER_BYTES {
            return Err(ExtensionError::InvalidRequest(format!(
                "network headers exceed {MAX_HEADER_BYTES} bytes"
            )));
        }
        let normalized_name = name.to_ascii_lowercase();
        if matches!(
            normalized_name.as_str(),
            "connection"
                | "content-length"
                | "cookie"
                | "host"
                | "proxy-authorization"
                | "te"
                | "trailer"
                | "transfer-encoding"
                | "upgrade"
        ) {
            return Err(ExtensionError::PermissionDenied(format!(
                "network header {name} is controlled by the broker"
            )));
        }
        let name = HeaderName::from_str(name).map_err(|error| {
            ExtensionError::InvalidRequest(format!("invalid network header name: {error}"))
        })?;
        let value = HeaderValue::from_str(value).map_err(|error| {
            ExtensionError::InvalidRequest(format!("invalid network header value: {error}"))
        })?;
        result.insert(name, value);
    }
    Ok(result)
}
