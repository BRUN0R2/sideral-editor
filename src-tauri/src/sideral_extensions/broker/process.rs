use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use serde_json::{Value, json};
use sideral_extension_core::{
    ExtensionManifest, ProcessArgument, ProcessExecutable, ProcessPathAccess,
    ProcessWorkingDirectory,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{Child, Command},
};

use super::{Cancellation, CapabilityBroker, require_workspace_permission, run_blocking};
use crate::sideral_extensions::error::ExtensionError;

const PROCESS_DEADLINE: Duration = Duration::from_secs(30);
const PROCESS_TERMINATION_DEADLINE: Duration = Duration::from_secs(2);
const MAX_PROCESS_OUTPUT_BYTES: usize = 1024 * 1024;

enum ProcessWaitOutcome {
    Completed(Result<(std::process::ExitStatus, String, String), ExtensionError>),
    Cancelled,
    DeadlineExceeded,
}

impl CapabilityBroker {
    pub(super) async fn execute_process(
        &self,
        manifest: &ExtensionManifest,
        grant: String,
        inputs: BTreeMap<String, String>,
        cancellation: Arc<Cancellation>,
    ) -> Result<Value, ExtensionError> {
        let permission = manifest
            .permissions
            .processes
            .iter()
            .find(|permission| permission.id == grant)
            .ok_or_else(|| {
                ExtensionError::PermissionDenied(format!("process grant {grant} was not declared"))
            })?
            .clone();
        let executable_value = match &permission.executable {
            ProcessExecutable::Literal { value } => value.clone(),
            ProcessExecutable::Configuration { key } => {
                self.configuration_value(manifest, key).await?
            }
        };
        let executable = resolve_process_executable(&executable_value)?;
        let _process_slot = self
            .shared
            .process_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                ExtensionError::Conflict("extension process pool is at capacity".to_owned())
            })?;
        let arguments = self.resolve_process_arguments(&permission.arguments, inputs)?;
        let working_directory = self
            .process_working_directory(manifest, permission.working_directory, &executable)
            .await?;
        let mut command = Command::new(executable);
        command
            .args(arguments)
            .current_dir(working_directory)
            .env_clear()
            .env("NO_COLOR", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for name in ["SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        let mut child = command.spawn().map_err(|error| {
            ExtensionError::io(
                format!("could not start process grant {}", permission.id),
                error,
            )
        })?;
        let standard_output = match child.stdout.take() {
            Some(output) => output,
            None => {
                return Err(terminate_process_after_error(
                    &mut child,
                    ExtensionError::Runtime("process stdout pipe is unavailable".to_owned()),
                )
                .await);
            }
        };
        let standard_error = match child.stderr.take() {
            Some(output) => output,
            None => {
                return Err(terminate_process_after_error(
                    &mut child,
                    ExtensionError::Runtime("process stderr pipe is unavailable".to_owned()),
                )
                .await);
            }
        };

        let outcome = {
            let completion = async {
                tokio::try_join!(
                    async {
                        child.wait().await.map_err(|error| {
                            ExtensionError::io("could not wait for extension process", error)
                        })
                    },
                    read_bounded_output(standard_output),
                    read_bounded_output(standard_error),
                )
            };
            tokio::pin!(completion);
            tokio::select! {
                () = cancellation.cancelled() => ProcessWaitOutcome::Cancelled,
                () = tokio::time::sleep(PROCESS_DEADLINE) => ProcessWaitOutcome::DeadlineExceeded,
                result = completion => ProcessWaitOutcome::Completed(result),
            }
        };
        let (status, standard_output, standard_error) = match outcome {
            ProcessWaitOutcome::Completed(Ok(result)) => result,
            ProcessWaitOutcome::Completed(Err(error)) => {
                return Err(terminate_process_after_error(&mut child, error).await);
            }
            ProcessWaitOutcome::Cancelled => {
                return Err(
                    terminate_process_after_error(&mut child, ExtensionError::Cancelled).await,
                );
            }
            ProcessWaitOutcome::DeadlineExceeded => {
                return Err(terminate_process_after_error(
                    &mut child,
                    ExtensionError::DeadlineExceeded,
                )
                .await);
            }
        };
        Ok(json!({
            "exitCode": status.code().unwrap_or(-1),
            "standardOutput": standard_output,
            "standardError": standard_error,
        }))
    }

    async fn process_working_directory(
        &self,
        manifest: &ExtensionManifest,
        working_directory: ProcessWorkingDirectory,
        executable: &Path,
    ) -> Result<PathBuf, ExtensionError> {
        match working_directory {
            ProcessWorkingDirectory::Workspace => {
                require_workspace_permission(manifest, false)?;
                self.workspace_root()
                    .map(|path| process_compatible_path(&path))
            }
            ProcessWorkingDirectory::ExtensionData => {
                let data_root = self.shared.data_root.join("data");
                let extension_directory = data_root.join(&manifest.id);
                run_blocking(move || create_contained_directory(&data_root, &extension_directory))
                    .await
                    .map(|path| process_compatible_path(&path))
            }
            ProcessWorkingDirectory::Executable => {
                executable.parent().map(Path::to_path_buf).ok_or_else(|| {
                    ExtensionError::Runtime(
                        "declared process executable has no parent directory".to_owned(),
                    )
                })
            }
        }
    }

    fn resolve_process_arguments(
        &self,
        declarations: &[ProcessArgument],
        mut inputs: BTreeMap<String, String>,
    ) -> Result<Vec<OsString>, ExtensionError> {
        let mut arguments = Vec::with_capacity(declarations.len());
        for declaration in declarations {
            match declaration {
                ProcessArgument::Literal { value } => arguments.push(OsString::from(value)),
                ProcessArgument::WorkspaceFile {
                    name,
                    access,
                    prefix,
                    extensions,
                } => {
                    let uri = take_process_input(&mut inputs, name)?;
                    let path = match access {
                        ProcessPathAccess::Read => self.canonical_workspace_file(&uri)?,
                        ProcessPathAccess::Write => self.workspace_output_file(&uri)?,
                    };
                    require_allowed_extension(name, &path, extensions)?;
                    let mut argument = OsString::from(prefix.as_deref().unwrap_or_default());
                    argument.push(process_compatible_path(&path).as_os_str());
                    arguments.push(argument);
                }
                ProcessArgument::WorkspaceDirectory {
                    name,
                    access: _,
                    prefix,
                } => {
                    let uri = take_process_input(&mut inputs, name)?;
                    let path = self.canonical_workspace_directory(&uri)?;
                    let mut argument = OsString::from(prefix.as_deref().unwrap_or_default());
                    argument.push(process_compatible_path(&path).as_os_str());
                    arguments.push(argument);
                }
            }
        }
        if let Some(name) = inputs.keys().next() {
            return Err(ExtensionError::InvalidRequest(format!(
                "process input {name} was not declared by the grant"
            )));
        }
        Ok(arguments)
    }
}

fn take_process_input(
    inputs: &mut BTreeMap<String, String>,
    name: &str,
) -> Result<String, ExtensionError> {
    let uri = inputs.remove(name).ok_or_else(|| {
        ExtensionError::InvalidRequest(format!("process input {name} was not provided"))
    })?;
    if uri.len() > 4_096 || uri.contains('\0') {
        return Err(ExtensionError::InvalidRequest(format!(
            "process input {name} is not a valid workspace URI"
        )));
    }
    Ok(uri)
}

fn require_allowed_extension(
    name: &str,
    path: &Path,
    allowed: &[String],
) -> Result<(), ExtensionError> {
    if allowed.is_empty() {
        return Ok(());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .ok_or_else(|| {
            ExtensionError::InvalidRequest(format!(
                "process input {name} has no supported file extension"
            ))
        })?;
    if allowed
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(&extension))
    {
        Ok(())
    } else {
        Err(ExtensionError::InvalidRequest(format!(
            "process input {name} must use one of: {}",
            allowed.join(", ")
        )))
    }
}

pub(super) fn resolve_process_executable(executable: &str) -> Result<PathBuf, ExtensionError> {
    let declared = Path::new(executable);
    if declared.is_absolute() {
        return canonical_executable(declared).ok_or_else(|| {
            ExtensionError::InvalidRequest(format!(
                "declared process executable {executable} is unavailable"
            ))
        });
    }
    if declared.components().count() != 1 {
        return Err(ExtensionError::PermissionDenied(
            "relative process executable paths are not allowed".to_owned(),
        ));
    }
    let search_path = std::env::var_os("PATH").ok_or_else(|| {
        ExtensionError::Runtime("the operating system process PATH is unavailable".to_owned())
    })?;
    for directory in std::env::split_paths(&search_path).filter(|path| path.is_absolute()) {
        let candidate = directory.join(declared);
        if let Some(executable) = canonical_executable(&candidate) {
            return Ok(executable);
        }
        #[cfg(windows)]
        if declared.extension().is_none() {
            for extension in ["exe", "com"] {
                let mut candidate = candidate.clone();
                candidate.set_extension(extension);
                if let Some(executable) = canonical_executable(&candidate) {
                    return Ok(executable);
                }
            }
        }
    }
    Err(ExtensionError::InvalidRequest(format!(
        "declared process executable {executable} was not found on the system PATH"
    )))
}

fn canonical_executable(path: &Path) -> Option<PathBuf> {
    let canonical = fs::canonicalize(path).ok()?;
    let metadata = fs::metadata(&canonical).ok()?;
    if !metadata.is_file() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if metadata.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some(process_compatible_path(&canonical))
}

#[cfg(windows)]
fn process_compatible_path(path: &Path) -> PathBuf {
    use std::os::windows::ffi::{OsStrExt as _, OsStringExt as _};

    const VERBATIM_PREFIX: &[u16] = &[b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
    const VERBATIM_UNC_PREFIX: &[u16] = &[
        b'\\' as u16,
        b'\\' as u16,
        b'?' as u16,
        b'\\' as u16,
        b'U' as u16,
        b'N' as u16,
        b'C' as u16,
        b'\\' as u16,
    ];
    let units = path.as_os_str().encode_wide().collect::<Vec<_>>();
    let normalized = if units.starts_with(VERBATIM_UNC_PREFIX) {
        let mut value = vec![b'\\' as u16, b'\\' as u16];
        value.extend_from_slice(&units[VERBATIM_UNC_PREFIX.len()..]);
        value
    } else if units.starts_with(VERBATIM_PREFIX) {
        units[VERBATIM_PREFIX.len()..].to_vec()
    } else {
        return path.to_path_buf();
    };
    PathBuf::from(OsString::from_wide(&normalized))
}

#[cfg(not(windows))]
fn process_compatible_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

async fn read_bounded_output(reader: impl AsyncRead + Unpin) -> Result<String, ExtensionError> {
    let mut bytes = Vec::new();
    let limit = u64::try_from(MAX_PROCESS_OUTPUT_BYTES)
        .map_err(|_| ExtensionError::Runtime("process output limit is invalid".to_owned()))?;
    reader
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| ExtensionError::io("could not read extension process output", error))?;
    if bytes.len() > MAX_PROCESS_OUTPUT_BYTES {
        return Err(ExtensionError::InvalidRequest(format!(
            "process output exceeds {MAX_PROCESS_OUTPUT_BYTES} bytes"
        )));
    }
    String::from_utf8(bytes)
        .map_err(|_| ExtensionError::InvalidRequest("process output is not UTF-8".to_owned()))
}

fn create_contained_directory(root: &Path, directory: &Path) -> Result<PathBuf, ExtensionError> {
    fs::create_dir_all(root).map_err(|error| {
        ExtensionError::io(
            format!("could not create extension data root {}", root.display()),
            error,
        )
    })?;
    let canonical_root = fs::canonicalize(root).map_err(|error| {
        ExtensionError::io(
            format!("could not resolve extension data root {}", root.display()),
            error,
        )
    })?;
    fs::create_dir_all(directory).map_err(|error| {
        ExtensionError::io(
            format!(
                "could not create extension process directory {}",
                directory.display()
            ),
            error,
        )
    })?;
    let canonical_directory = fs::canonicalize(directory).map_err(|error| {
        ExtensionError::io(
            format!(
                "could not resolve extension process directory {}",
                directory.display()
            ),
            error,
        )
    })?;
    if !canonical_directory.starts_with(&canonical_root) {
        return Err(ExtensionError::PermissionDenied(
            "extension process directory escapes the extension data root".to_owned(),
        ));
    }
    Ok(canonical_directory)
}

async fn terminate_process(child: &mut Child) -> Result<(), ExtensionError> {
    if child
        .try_wait()
        .map_err(|error| ExtensionError::io("could not inspect extension process", error))?
        .is_some()
    {
        return Ok(());
    }

    child
        .start_kill()
        .map_err(|error| ExtensionError::io("could not terminate extension process", error))?;
    tokio::time::timeout(PROCESS_TERMINATION_DEADLINE, child.wait())
        .await
        .map_err(|_| {
            ExtensionError::Runtime(
                "extension process did not terminate within the cleanup deadline".to_owned(),
            )
        })?
        .map_err(|error| ExtensionError::io("could not reap extension process", error))?;
    Ok(())
}

async fn terminate_process_after_error(
    child: &mut Child,
    operation_error: ExtensionError,
) -> ExtensionError {
    match terminate_process(child).await {
        Ok(()) => operation_error,
        Err(cleanup_error) => ExtensionError::Runtime(format!(
            "{operation_error}; process cleanup also failed: {cleanup_error}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, ffi::OsString, fs, sync::Arc};

    use serde_json::json;
    use sideral_extension_core::{ProcessArgument, ProcessPathAccess, parse_manifest_json};
    use tempfile::tempdir;
    use url::Url;

    use super::{Cancellation, CapabilityBroker, process_compatible_path};
    use crate::sideral_extensions::{error::ExtensionError, protocol::ConfigurationUpdate};

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[cfg(windows)]
    #[test]
    fn removes_windows_verbatim_prefixes_only_after_path_validation() {
        assert_eq!(
            process_compatible_path(std::path::Path::new(r"\\?\D:\workspace\source.input")),
            std::path::PathBuf::from(r"D:\workspace\source.input")
        );
        assert_eq!(
            process_compatible_path(std::path::Path::new(r"\\?\UNC\server\share\source.input")),
            std::path::PathBuf::from(r"\\server\share\source.input")
        );
    }

    #[test]
    fn resolves_only_declared_workspace_file_inputs() -> TestResult {
        let directory = tempdir()?;
        let workspace = directory.path().join("workspace");
        fs::create_dir(&workspace)?;
        let source = workspace.join("source.input");
        let output = workspace.join("result.output");
        let include = workspace.join("include");
        fs::create_dir(&include)?;
        fs::write(&source, "fixture")?;
        let broker = CapabilityBroker::new(directory.path().join("extensions"))?;
        broker.set_workspace_root(Some(workspace))?;
        let source_uri = Url::from_file_path(&source)
            .map_err(|()| "source path has no file URI")?
            .to_string();
        let output_uri = Url::from_file_path(&output)
            .map_err(|()| "output path has no file URI")?
            .to_string();
        let include_uri = Url::from_directory_path(&include)
            .map_err(|()| "include path has no file URI")?
            .to_string();
        let declarations = [
            ProcessArgument::WorkspaceFile {
                name: "source".to_owned(),
                access: ProcessPathAccess::Read,
                prefix: None,
                extensions: vec![".input".to_owned()],
            },
            ProcessArgument::WorkspaceDirectory {
                name: "project-include".to_owned(),
                access: ProcessPathAccess::Read,
                prefix: Some("-i".to_owned()),
            },
            ProcessArgument::WorkspaceFile {
                name: "output".to_owned(),
                access: ProcessPathAccess::Write,
                prefix: Some("-o".to_owned()),
                extensions: vec![".output".to_owned()],
            },
        ];
        let arguments = broker.resolve_process_arguments(
            &declarations,
            BTreeMap::from([
                ("source".to_owned(), source_uri),
                ("project-include".to_owned(), include_uri),
                ("output".to_owned(), output_uri),
            ]),
        )?;

        let canonical_source = process_compatible_path(&fs::canonicalize(source)?);
        let canonical_include = process_compatible_path(&fs::canonicalize(include)?);
        let canonical_output_parent =
            process_compatible_path(&fs::canonicalize(output.parent().ok_or("missing parent")?)?);
        let mut expected_include = OsString::from("-i");
        expected_include.push(canonical_include);
        let mut expected_output = OsString::from("-o");
        expected_output.push(canonical_output_parent.join("result.output"));
        assert_eq!(
            arguments,
            vec![
                canonical_source.into_os_string(),
                expected_include,
                expected_output,
            ]
        );
        Ok(())
    }

    #[test]
    fn rejects_undeclared_and_outside_workspace_inputs() -> TestResult {
        let directory = tempdir()?;
        let workspace = directory.path().join("workspace");
        fs::create_dir(&workspace)?;
        let outside = directory.path().join("outside.input");
        fs::write(&outside, "fixture")?;
        let broker = CapabilityBroker::new(directory.path().join("extensions"))?;
        broker.set_workspace_root(Some(workspace))?;
        let declaration = [ProcessArgument::WorkspaceFile {
            name: "source".to_owned(),
            access: ProcessPathAccess::Read,
            prefix: None,
            extensions: vec![".input".to_owned()],
        }];
        let outside_uri = Url::from_file_path(outside)
            .map_err(|()| "outside path has no file URI")?
            .to_string();

        let outside_result = broker.resolve_process_arguments(
            &declaration,
            BTreeMap::from([("source".to_owned(), outside_uri)]),
        );
        assert!(matches!(
            outside_result,
            Err(ExtensionError::PermissionDenied(_))
        ));

        let outside_directory = directory.path().join("outside-include");
        fs::create_dir(&outside_directory)?;
        let outside_directory_uri = Url::from_directory_path(outside_directory)
            .map_err(|()| "outside include path has no file URI")?
            .to_string();
        let directory_result = broker.resolve_process_arguments(
            &[ProcessArgument::WorkspaceDirectory {
                name: "project-include".to_owned(),
                access: ProcessPathAccess::Read,
                prefix: Some("-i".to_owned()),
            }],
            BTreeMap::from([("project-include".to_owned(), outside_directory_uri)]),
        );
        assert!(matches!(
            directory_result,
            Err(ExtensionError::PermissionDenied(_))
        ));

        let undeclared_result = broker.resolve_process_arguments(
            &[],
            BTreeMap::from([("source".to_owned(), "file:///outside.input".to_owned())]),
        );
        assert!(matches!(
            undeclared_result,
            Err(ExtensionError::InvalidRequest(_))
        ));
        Ok(())
    }

    #[tokio::test]
    async fn executes_a_process_from_an_executable_configuration() -> TestResult {
        let directory = tempdir()?;
        let executable = fs::canonicalize(std::env::current_exe()?)?;
        let grant = "sample.tool.inspect";
        let manifest = parse_manifest_json(
            &json!({
                "manifestVersion": 1,
                "apiVersion": 1,
                "id": "sample.tool",
                "displayName": "Sample Tool",
                "version": "0.1.0",
                "engines": { "sideral": "^0.1.0" },
                "runtime": { "kind": "worker", "entry": "dist/extension.mjs" },
                "activationEvents": ["onWorkbenchReady"],
                "permissions": {
                    "workspace": "none",
                    "processes": [{
                        "id": grant,
                        "executable": { "kind": "configuration", "key": "tool-path" },
                        "workingDirectory": "extensionData",
                        "arguments": [
                            { "kind": "literal", "value": "--help" }
                        ]
                    }]
                },
                "contributes": {
                    "configuration": {
                        "title": "Sample Tool",
                        "properties": [{
                            "kind": "executable",
                            "key": "tool-path",
                            "title": "Tool Path",
                            "default": "tool"
                        }]
                    }
                }
            })
            .to_string(),
        )?;
        let broker = CapabilityBroker::new(directory.path().join("broker-data"))?;
        broker
            .update_configuration(
                manifest.clone(),
                "tool-path".to_owned(),
                ConfigurationUpdate::Value {
                    value: executable.to_string_lossy().into_owned(),
                },
            )
            .await?;

        let result = broker
            .execute_process(
                &manifest,
                grant.to_owned(),
                BTreeMap::new(),
                Arc::new(Cancellation::default()),
            )
            .await?;

        assert_eq!(result["exitCode"], json!(0));
        assert!(
            result["standardOutput"]
                .as_str()
                .is_some_and(|text| !text.is_empty())
        );
        Ok(())
    }
}
