use std::{
    fs,
    path::{Path, PathBuf},
};

#[cfg(windows)]
use std::{io, os::windows::fs::MetadataExt};

use crate::error::{AppError, AppResult};

#[cfg(windows)]
const ERROR_CANT_ACCESS_FILE: i32 = 1920;
#[cfg(windows)]
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

pub(super) enum ShellCandidate {
    Ready(ShellProfile),
    Unavailable(String),
}

pub(super) struct ShellProfile {
    pub(super) arguments: &'static [&'static str],
    pub(super) executable: PathBuf,
    pub(super) name: &'static str,
}

pub(super) fn resolve_working_directory(
    workspace_root: Option<String>,
    home_directory: PathBuf,
) -> AppResult<PathBuf> {
    let requested = match workspace_root {
        Some(root) if root.is_empty() => {
            return Err(AppError::InvalidPath(
                "the terminal workspace root is empty".to_owned(),
            ));
        }
        Some(root) => PathBuf::from(root),
        None => home_directory,
    };
    canonical_directory(&requested)
}

pub(super) fn path_to_string(path: &Path, context: &str) -> AppResult<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| AppError::InvalidPath(format!("{context} is not valid Unicode")))
}

fn canonical_directory(path: &Path) -> AppResult<PathBuf> {
    let canonical = fs::canonicalize(path).map_err(|error| {
        AppError::io(
            format!("could not resolve terminal directory {}", path.display()),
            error,
        )
    })?;
    let metadata = fs::metadata(&canonical).map_err(|error| {
        AppError::io(
            format!(
                "could not inspect terminal directory {}",
                canonical.display()
            ),
            error,
        )
    })?;
    if !metadata.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "terminal directory is not a folder: {}",
            canonical.display()
        )));
    }
    Ok(canonical)
}

#[cfg(windows)]
pub(super) fn resolve_shell_candidates() -> Vec<ShellCandidate> {
    let mut candidates = find_executables_on_path("pwsh.exe")
        .into_iter()
        .map(|candidate| match candidate {
            Ok(executable) => ShellCandidate::Ready(ShellProfile {
                arguments: &["-NoLogo", "-NoProfile"],
                executable,
                name: "PowerShell 7",
            }),
            Err(error) => ShellCandidate::Unavailable(error.to_string()),
        })
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        candidates.push(ShellCandidate::Unavailable(
            "PowerShell 7 is unavailable because pwsh.exe was not found on PATH".to_owned(),
        ));
    }

    candidates.push(match std::env::var_os("ComSpec") {
        Some(command_prompt) => match canonical_executable(Path::new(&command_prompt)) {
            Ok(executable) => ShellCandidate::Ready(ShellProfile {
                arguments: &["/D"],
                executable,
                name: "Command Prompt",
            }),
            Err(error) => ShellCandidate::Unavailable(error.to_string()),
        },
        None => ShellCandidate::Unavailable(
            "Command Prompt is unavailable because ComSpec is unset".to_owned(),
        ),
    });
    candidates
}

#[cfg(windows)]
fn find_executables_on_path(file_name: &str) -> Vec<AppResult<PathBuf>> {
    let Some(path) = std::env::var_os("PATH") else {
        return Vec::new();
    };
    let mut candidates = Vec::new();
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join(file_name);
        match fs::metadata(&candidate) {
            Ok(metadata) if metadata.is_file() => {
                candidates.push(windows_path_executable(&candidate));
            }
            Ok(_) => {
                candidates.push(Err(AppError::Terminal(format!(
                    "terminal shell candidate is not a file: {}",
                    candidate.display()
                ))));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                candidates.push(Err(AppError::io(
                    format!("could not inspect terminal shell {}", candidate.display()),
                    error,
                )));
            }
        }
    }
    candidates
}

#[cfg(windows)]
fn windows_path_executable(path: &Path) -> AppResult<PathBuf> {
    match fs::canonicalize(path) {
        Ok(canonical) => inspected_executable(canonical),
        // Windows App Execution Aliases are process launchers, not readable files.
        Err(error) if is_windows_launch_reparse_point(path, &error) => Ok(path.to_path_buf()),
        Err(error) => Err(AppError::io(
            format!("could not resolve terminal shell {}", path.display()),
            error,
        )),
    }
}

#[cfg(windows)]
fn is_windows_launch_reparse_point(path: &Path, error: &io::Error) -> bool {
    if error.raw_os_error() != Some(ERROR_CANT_ACCESS_FILE) {
        return false;
    }
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    is_windows_launch_reparse_metadata(metadata.file_attributes(), metadata.file_size())
}

#[cfg(windows)]
fn is_windows_launch_reparse_metadata(file_attributes: u32, file_size: u64) -> bool {
    file_attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        && file_attributes & FILE_ATTRIBUTE_DIRECTORY == 0
        && file_size == 0
}

#[cfg(not(windows))]
pub(super) fn resolve_shell_candidates() -> Vec<ShellCandidate> {
    vec![match std::env::var_os("SHELL") {
        Some(shell) => match canonical_executable(Path::new(&shell)) {
            Ok(executable) => ShellCandidate::Ready(ShellProfile {
                arguments: &[],
                executable,
                name: "Shell",
            }),
            Err(error) => ShellCandidate::Unavailable(error.to_string()),
        },
        None => {
            ShellCandidate::Unavailable("the SHELL environment variable is unavailable".to_owned())
        }
    }]
}

fn canonical_executable(path: &Path) -> AppResult<PathBuf> {
    let canonical = fs::canonicalize(path).map_err(|error| {
        AppError::io(
            format!("could not resolve terminal shell {}", path.display()),
            error,
        )
    })?;
    inspected_executable(canonical)
}

fn inspected_executable(path: PathBuf) -> AppResult<PathBuf> {
    let metadata = fs::metadata(&path).map_err(|error| {
        AppError::io(
            format!("could not inspect terminal shell {}", path.display()),
            error,
        )
    })?;
    if !metadata.is_file() {
        return Err(AppError::Terminal(format!(
            "terminal shell is not a file: {}",
            path.display()
        )));
    }
    Ok(path)
}

#[cfg(all(test, windows))]
mod tests {
    use super::{
        ERROR_CANT_ACCESS_FILE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        is_windows_launch_reparse_metadata, windows_path_executable,
    };
    use crate::error::AppResult;

    #[test]
    fn recognizes_only_zero_length_file_reparse_launchers() {
        assert!(is_windows_launch_reparse_metadata(
            FILE_ATTRIBUTE_REPARSE_POINT,
            0
        ));
        assert!(!is_windows_launch_reparse_metadata(0, 0));
        assert!(!is_windows_launch_reparse_metadata(
            FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY,
            0
        ));
        assert!(!is_windows_launch_reparse_metadata(
            FILE_ATTRIBUTE_REPARSE_POINT,
            1
        ));
        assert_eq!(ERROR_CANT_ACCESS_FILE, 1920);
    }

    #[test]
    fn preserves_an_installed_windows_app_execution_alias() -> AppResult<()> {
        let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") else {
            return Ok(());
        };
        let alias = std::path::PathBuf::from(local_app_data)
            .join("Microsoft")
            .join("WindowsApps")
            .join("pwsh.exe");
        let Err(error) = std::fs::canonicalize(&alias) else {
            return Ok(());
        };
        if error.raw_os_error() != Some(ERROR_CANT_ACCESS_FILE) {
            return Ok(());
        }

        assert_eq!(windows_path_executable(&alias)?, alias);
        Ok(())
    }
}
