use std::{collections::HashSet, ffi::OsString, path::Path};

use serde::Serialize;

use crate::{
    desktop_integration::MINIMIZED_STARTUP_ARGUMENT,
    error::{AppError, CommandError},
};

pub const MAX_LAUNCH_TARGETS: usize = 128;
const MAX_LAUNCH_BYTES: usize = 128 * 1024;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchFiles {
    pub paths: Vec<String>,
    pub errors: Vec<CommandError>,
}

pub struct ParsedLaunch {
    pub files: LaunchFiles,
    pub reveal_window: bool,
}

pub fn parse_launch(arguments: impl IntoIterator<Item = OsString>, cwd: &Path) -> ParsedLaunch {
    let mut files = LaunchFiles::default();
    let mut seen = HashSet::new();
    let mut positional_only = false;
    let mut minimized = false;
    let mut argument_bytes = 0;

    for (index, argument) in arguments.into_iter().enumerate() {
        if index >= MAX_LAUNCH_TARGETS {
            files.errors.truncate(MAX_LAUNCH_TARGETS - 1);
            files
                .errors
                .push(CommandError::from(AppError::InvalidPath(format!(
                    "a launch cannot contain more than {MAX_LAUNCH_TARGETS} arguments"
                ))));
            break;
        }
        let Some(argument) = argument.to_str() else {
            files.errors.push(CommandError::from(AppError::InvalidPath(
                "the launch argument is not valid Unicode".to_owned(),
            )));
            continue;
        };
        argument_bytes += argument.len();
        if argument_bytes > MAX_LAUNCH_BYTES {
            files.errors.push(CommandError::from(AppError::InvalidPath(
                "the combined launch arguments are too long".to_owned(),
            )));
            break;
        }
        if !positional_only {
            if argument == "--" {
                positional_only = true;
                continue;
            }
            if argument == MINIMIZED_STARTUP_ARGUMENT {
                minimized = true;
                continue;
            }
            if argument.starts_with('-') {
                files
                    .errors
                    .push(CommandError::from(AppError::InvalidPath(format!(
                        "unsupported launch option: {argument}"
                    ))));
                continue;
            }
        }

        let path = Path::new(argument);
        if argument.is_empty() || (!path.is_absolute() && !cwd.is_absolute()) {
            files.errors.push(CommandError::from(AppError::InvalidPath(
                "a file launch requires a path and an absolute working directory".to_owned(),
            )));
            continue;
        }
        let absolute = std::path::absolute(cwd.join(path));
        match absolute {
            Ok(path) => {
                let path = path.to_string_lossy().into_owned();
                let key = if cfg!(windows) {
                    path.replace('\\', "/").to_lowercase()
                } else {
                    path.clone()
                };
                if seen.insert(key) {
                    files.paths.push(path);
                }
            }
            Err(error) => files.errors.push(CommandError::from(AppError::io(
                format!("could not resolve {argument}"),
                error,
            ))),
        }
    }

    let reveal_window = !minimized || !files.paths.is_empty() || !files.errors.is_empty();
    ParsedLaunch {
        files,
        reveal_window,
    }
}

impl LaunchFiles {
    pub fn is_empty(&self) -> bool {
        self.paths.is_empty() && self.errors.is_empty()
    }

    pub fn byte_size(&self) -> usize {
        self.paths.iter().map(String::len).sum::<usize>()
            + self
                .errors
                .iter()
                .map(|error| error.message.len())
                .sum::<usize>()
    }
}
