use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use serde_json::{Value, json};
use sideral_extension_core::{ExtensionManifest, ProcessWorkingDirectory};
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
        let _process_slot = self
            .shared
            .process_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                ExtensionError::Conflict("extension process pool is at capacity".to_owned())
            })?;
        let executable = resolve_process_executable(&permission.executable)?;
        let working_directory = self
            .process_working_directory(manifest, permission.working_directory)
            .await?;
        let mut command = Command::new(executable);
        command
            .args(&permission.arguments)
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
    ) -> Result<PathBuf, ExtensionError> {
        match working_directory {
            ProcessWorkingDirectory::Workspace => {
                require_workspace_permission(manifest, false)?;
                self.workspace_root()
            }
            ProcessWorkingDirectory::ExtensionData => {
                let data_root = self.shared.data_root.join("data");
                let extension_directory = data_root.join(&manifest.id);
                run_blocking(move || create_contained_directory(&data_root, &extension_directory))
                    .await
            }
        }
    }
}

fn resolve_process_executable(executable: &str) -> Result<PathBuf, ExtensionError> {
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
    Some(canonical)
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
