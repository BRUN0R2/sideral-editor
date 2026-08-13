use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use url::Url;

use crate::{ManifestError, configuration::validate_configuration_key};

const MAX_NETWORK_ORIGINS: usize = 32;
const MAX_PROCESS_PERMISSIONS: usize = 16;
const MAX_PROCESS_ARGUMENTS: usize = 32;
const MAX_PROCESS_ARGUMENT_EXTENSIONS: usize = 16;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceAccess {
    #[default]
    None,
    Read,
    ReadWrite,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessWorkingDirectory {
    Workspace,
    ExtensionData,
    Executable,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessPathAccess {
    Read,
    Write,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProcessExecutable {
    Literal { value: String },
    Configuration { key: String },
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProcessArgument {
    Literal {
        value: String,
    },
    WorkspaceFile {
        name: String,
        access: ProcessPathAccess,
        #[serde(default)]
        prefix: Option<String>,
        #[serde(default)]
        extensions: Vec<String>,
    },
    WorkspaceDirectory {
        name: String,
        access: ProcessPathAccess,
        #[serde(default)]
        prefix: Option<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessPermission {
    pub id: String,
    pub executable: ProcessExecutable,
    pub working_directory: ProcessWorkingDirectory,
    #[serde(default)]
    pub arguments: Vec<ProcessArgument>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub enum NetworkMethod {
    GET,
    POST,
    PUT,
    PATCH,
    DELETE,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkPermission {
    pub origin: String,
    #[serde(default = "default_network_methods")]
    pub methods: Vec<NetworkMethod>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionSet {
    #[serde(default)]
    pub workspace: WorkspaceAccess,
    #[serde(default)]
    pub network: Vec<NetworkPermission>,
    #[serde(default)]
    pub processes: Vec<ProcessPermission>,
}

impl PermissionSet {
    pub(crate) fn validate(
        &self,
        extension_id: &str,
        executable_configuration_keys: &HashSet<&str>,
    ) -> Result<(), ManifestError> {
        validate_network_origins(&self.network)?;
        validate_process_permissions(
            extension_id,
            self.workspace,
            &self.processes,
            executable_configuration_keys,
        )
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.workspace == WorkspaceAccess::None
            && self.network.is_empty()
            && self.processes.is_empty()
    }
}

fn default_network_methods() -> Vec<NetworkMethod> {
    vec![NetworkMethod::GET]
}

fn validate_network_origins(permissions: &[NetworkPermission]) -> Result<(), ManifestError> {
    if permissions.len() > MAX_NETWORK_ORIGINS {
        return Err(ManifestError::invalid(
            "permissions.network",
            format!("at most {MAX_NETWORK_ORIGINS} origins are allowed"),
        ));
    }

    let mut normalized_origins = HashSet::new();
    for permission in permissions {
        let parsed = Url::parse(&permission.origin).map_err(|error| {
            ManifestError::invalid(
                "permissions.network",
                format!("{}: {error}", permission.origin),
            )
        })?;
        let host = parsed.host_str().ok_or_else(|| {
            ManifestError::invalid(
                "permissions.network",
                format!("{} has no host", permission.origin),
            )
        })?;
        let secure = parsed.scheme() == "https";
        let loopback_http = parsed.scheme() == "http" && is_loopback_host(host);

        if !secure && !loopback_http {
            return Err(ManifestError::invalid(
                "permissions.network",
                format!(
                    "{} must use HTTPS; HTTP is limited to loopback hosts",
                    permission.origin
                ),
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
                format!(
                    "{} must be an origin without credentials, path, query or fragment",
                    permission.origin
                ),
            ));
        }

        if permission.methods.is_empty() {
            return Err(ManifestError::invalid(
                "permissions.network.methods",
                "at least one method is required",
            ));
        }
        let mut unique_methods = HashSet::new();
        for method in &permission.methods {
            if !unique_methods.insert(*method) {
                return Err(ManifestError::Duplicate {
                    kind: "network method",
                    value: format!("{} {method:?}", permission.origin),
                });
            }
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
    extension_id: &str,
    workspace_access: WorkspaceAccess,
    permissions: &[ProcessPermission],
    executable_configuration_keys: &HashSet<&str>,
) -> Result<(), ManifestError> {
    if permissions.len() > MAX_PROCESS_PERMISSIONS {
        return Err(ManifestError::invalid(
            "permissions.processes",
            format!("at most {MAX_PROCESS_PERMISSIONS} process grants are allowed"),
        ));
    }

    let mut unique_permission_ids = HashSet::new();
    let expected_prefix = format!("{extension_id}.");
    for permission in permissions {
        validate_process_permission_id(&permission.id, &expected_prefix)?;
        match &permission.executable {
            ProcessExecutable::Literal { value } => {
                validate_clean_text("permissions.processes.executable.value", value, 4_096)?
            }
            ProcessExecutable::Configuration { key } => {
                validate_configuration_key("permissions.processes.executable.key", key)?;
                if !executable_configuration_keys.contains(key.as_str()) {
                    return Err(ManifestError::Inconsistent(format!(
                        "process grant {} references undeclared executable configuration {key}",
                        permission.id
                    )));
                }
            }
        }
        if permission.arguments.len() > MAX_PROCESS_ARGUMENTS {
            return Err(ManifestError::invalid(
                "permissions.processes.arguments",
                format!("at most {MAX_PROCESS_ARGUMENTS} arguments are allowed"),
            ));
        }
        let mut input_names = HashSet::new();
        for argument in &permission.arguments {
            match argument {
                ProcessArgument::Literal { value } => validate_process_argument(value)?,
                ProcessArgument::WorkspaceFile {
                    name,
                    access,
                    prefix,
                    extensions,
                } => {
                    validate_process_path_input(
                        &permission.id,
                        workspace_access,
                        &mut input_names,
                        name,
                        *access,
                        prefix.as_deref(),
                    )?;
                    validate_process_extensions(extensions)?;
                }
                ProcessArgument::WorkspaceDirectory {
                    name,
                    access,
                    prefix,
                } => validate_process_path_input(
                    &permission.id,
                    workspace_access,
                    &mut input_names,
                    name,
                    *access,
                    prefix.as_deref(),
                )?,
            }
        }
        if permission.working_directory == ProcessWorkingDirectory::Workspace
            && workspace_access == WorkspaceAccess::None
        {
            return Err(ManifestError::Inconsistent(format!(
                "process grant {} uses the workspace working directory without workspace access",
                permission.id
            )));
        }
        if !unique_permission_ids.insert(permission.id.as_str()) {
            return Err(ManifestError::Duplicate {
                kind: "process permission id",
                value: permission.id.clone(),
            });
        }
    }

    Ok(())
}

fn validate_process_path_input(
    permission_id: &str,
    workspace_access: WorkspaceAccess,
    input_names: &mut HashSet<String>,
    name: &str,
    access: ProcessPathAccess,
    prefix: Option<&str>,
) -> Result<(), ManifestError> {
    validate_process_input_name(name)?;
    if !input_names.insert(name.to_owned()) {
        return Err(ManifestError::Duplicate {
            kind: "process input name",
            value: name.to_owned(),
        });
    }
    if let Some(prefix) = prefix {
        validate_clean_text("permissions.processes.arguments.prefix", prefix, 64)?;
    }
    let permitted = match (workspace_access, access) {
        (WorkspaceAccess::Read | WorkspaceAccess::ReadWrite, ProcessPathAccess::Read)
        | (WorkspaceAccess::ReadWrite, ProcessPathAccess::Write) => true,
        (WorkspaceAccess::None, ProcessPathAccess::Read | ProcessPathAccess::Write)
        | (WorkspaceAccess::Read, ProcessPathAccess::Write) => false,
    };
    if permitted {
        Ok(())
    } else {
        Err(ManifestError::Inconsistent(format!(
            "process grant {permission_id} declares {access:?} workspace input {name} without sufficient workspace access"
        )))
    }
}

fn validate_process_permission_id(value: &str, expected_prefix: &str) -> Result<(), ManifestError> {
    if !value.starts_with(expected_prefix)
        || value.len() > 128
        || value.split('.').any(|segment| {
            segment.is_empty()
                || segment.starts_with('-')
                || segment.ends_with('-')
                || !segment
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
    {
        return Err(ManifestError::invalid(
            "permissions.processes.id",
            format!("value must start with {expected_prefix} and use a namespaced identifier"),
        ));
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

fn validate_process_input_name(value: &str) -> Result<(), ManifestError> {
    if value.is_empty()
        || value.len() > 64
        || value.starts_with('-')
        || value.ends_with('-')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(ManifestError::invalid(
            "permissions.processes.arguments.name",
            "value must use lowercase ASCII letters, digits or inner hyphens",
        ));
    }
    Ok(())
}

fn validate_process_extensions(extensions: &[String]) -> Result<(), ManifestError> {
    if extensions.len() > MAX_PROCESS_ARGUMENT_EXTENSIONS {
        return Err(ManifestError::invalid(
            "permissions.processes.arguments.extensions",
            format!("at most {MAX_PROCESS_ARGUMENT_EXTENSIONS} extensions are allowed"),
        ));
    }
    let mut unique_extensions = HashSet::new();
    for extension in extensions {
        if extension.len() < 2
            || extension.len() > 32
            || !extension.starts_with('.')
            || !extension[1..]
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        {
            return Err(ManifestError::invalid(
                "permissions.processes.arguments.extensions",
                "values must be lowercase dot-prefixed file extensions",
            ));
        }
        if !unique_extensions.insert(extension.as_str()) {
            return Err(ManifestError::Duplicate {
                kind: "process argument extension",
                value: extension.clone(),
            });
        }
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
        return Err(ManifestError::invalid(
            field,
            "value cannot contain NUL bytes",
        ));
    }
    Ok(())
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}
