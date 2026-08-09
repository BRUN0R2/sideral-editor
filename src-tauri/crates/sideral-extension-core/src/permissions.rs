use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use url::Url;

use crate::ManifestError;

const MAX_NETWORK_ORIGINS: usize = 32;
const MAX_PROCESS_PERMISSIONS: usize = 16;
const MAX_PROCESS_ARGUMENTS: usize = 32;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceAccess {
    #[default]
    None,
    Read,
    ReadWrite,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessPermission {
    pub executable: String,
    #[serde(default)]
    pub arguments: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionSet {
    #[serde(default)]
    pub workspace: WorkspaceAccess,
    #[serde(default)]
    pub network: Vec<String>,
    #[serde(default)]
    pub processes: Vec<ProcessPermission>,
}

impl PermissionSet {
    pub(crate) fn validate(&self) -> Result<(), ManifestError> {
        validate_network_origins(&self.network)?;
        validate_process_permissions(&self.processes)
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.workspace == WorkspaceAccess::None
            && self.network.is_empty()
            && self.processes.is_empty()
    }
}

fn validate_network_origins(origins: &[String]) -> Result<(), ManifestError> {
    if origins.len() > MAX_NETWORK_ORIGINS {
        return Err(ManifestError::invalid(
            "permissions.network",
            format!("at most {MAX_NETWORK_ORIGINS} origins are allowed"),
        ));
    }

    let mut normalized_origins = HashSet::new();
    for origin in origins {
        let parsed = Url::parse(origin).map_err(|error| {
            ManifestError::invalid("permissions.network", format!("{origin}: {error}"))
        })?;
        let host = parsed.host_str().ok_or_else(|| {
            ManifestError::invalid("permissions.network", format!("{origin} has no host"))
        })?;
        let secure = parsed.scheme() == "https";
        let loopback_http = parsed.scheme() == "http" && is_loopback_host(host);

        if !secure && !loopback_http {
            return Err(ManifestError::invalid(
                "permissions.network",
                format!("{origin} must use HTTPS; HTTP is limited to loopback hosts"),
            ));
        }
        if !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.path() != "/"
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(ManifestError::invalid(
                "permissions.network",
                format!("{origin} must be an origin without credentials, path, query or fragment"),
            ));
        }

        let normalized = parsed.origin().ascii_serialization();
        if !normalized_origins.insert(normalized.clone()) {
            return Err(ManifestError::Duplicate {
                kind: "network origin",
                value: normalized,
            });
        }
    }

    Ok(())
}

fn validate_process_permissions(
    permissions: &[ProcessPermission],
) -> Result<(), ManifestError> {
    if permissions.len() > MAX_PROCESS_PERMISSIONS {
        return Err(ManifestError::invalid(
            "permissions.processes",
            format!("at most {MAX_PROCESS_PERMISSIONS} process grants are allowed"),
        ));
    }

    let mut unique_permissions = HashSet::new();
    for permission in permissions {
        validate_clean_text(
            "permissions.processes.executable",
            &permission.executable,
            260,
        )?;
        if permission.arguments.len() > MAX_PROCESS_ARGUMENTS {
            return Err(ManifestError::invalid(
                "permissions.processes.arguments",
                format!("at most {MAX_PROCESS_ARGUMENTS} arguments are allowed"),
            ));
        }
        for argument in &permission.arguments {
            validate_process_argument(argument)?;
        }
        if !unique_permissions.insert(permission.clone()) {
            return Err(ManifestError::Duplicate {
                kind: "process permission",
                value: permission.executable.clone(),
            });
        }
    }

    Ok(())
}

fn validate_process_argument(value: &str) -> Result<(), ManifestError> {
    if value.len() > 1_024 {
        return Err(ManifestError::invalid(
            "permissions.processes.arguments",
            "value cannot exceed 1024 bytes",
        ));
    }
    if value.contains('\0') {
        return Err(ManifestError::invalid(
            "permissions.processes.arguments",
            "value cannot contain NUL bytes",
        ));
    }
    Ok(())
}

fn validate_clean_text(
    field: &'static str,
    value: &str,
    max_length: usize,
) -> Result<(), ManifestError> {
    if value.is_empty() || value.trim() != value {
        return Err(ManifestError::invalid(
            field,
            "value must be non-empty and cannot have surrounding whitespace",
        ));
    }
    if value.len() > max_length {
        return Err(ManifestError::invalid(
            field,
            format!("value cannot exceed {max_length} bytes"),
        ));
    }
    if value.contains('\0') {
        return Err(ManifestError::invalid(field, "value cannot contain NUL bytes"));
    }
    Ok(())
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}
