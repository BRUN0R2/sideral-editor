use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::error::{AppError, AppResult};

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
pub(super) fn resolve_shell_profile() -> AppResult<ShellProfile> {
    if let Some(executable) = find_executable_on_path("pwsh.exe")? {
        return Ok(ShellProfile {
            arguments: &["-NoLogo", "-NoProfile"],
            executable,
            name: "PowerShell 7",
        });
    }

    let command_prompt = std::env::var_os("ComSpec").ok_or_else(|| {
        AppError::Terminal(
            "no supported Windows shell is available: pwsh.exe was not found and ComSpec is unset"
                .to_owned(),
        )
    })?;
    Ok(ShellProfile {
        arguments: &["/D"],
        executable: canonical_executable(Path::new(&command_prompt))?,
        name: "Command Prompt",
    })
}

#[cfg(windows)]
fn find_executable_on_path(file_name: &str) -> AppResult<Option<PathBuf>> {
    let Some(path) = std::env::var_os("PATH") else {
        return Ok(None);
    };
    for directory in std::env::split_paths(&path) {
        let candidate = directory.join(file_name);
        if candidate.is_file() {
            return canonical_executable(&candidate).map(Some);
        }
    }
    Ok(None)
}

#[cfg(not(windows))]
pub(super) fn resolve_shell_profile() -> AppResult<ShellProfile> {
    let shell = std::env::var_os("SHELL").ok_or_else(|| {
        AppError::Terminal("the SHELL environment variable is unavailable".to_owned())
    })?;
    let executable = canonical_executable(Path::new(&shell))?;
    Ok(ShellProfile {
        arguments: &[],
        executable,
        name: "Shell",
    })
}

fn canonical_executable(path: &Path) -> AppResult<PathBuf> {
    let canonical = fs::canonicalize(path).map_err(|error| {
        AppError::io(
            format!("could not resolve terminal shell {}", path.display()),
            error,
        )
    })?;
    let metadata = fs::metadata(&canonical).map_err(|error| {
        AppError::io(
            format!("could not inspect terminal shell {}", canonical.display()),
            error,
        )
    })?;
    if !metadata.is_file() {
        return Err(AppError::Terminal(format!(
            "terminal shell is not a file: {}",
            canonical.display()
        )));
    }
    Ok(canonical)
}
