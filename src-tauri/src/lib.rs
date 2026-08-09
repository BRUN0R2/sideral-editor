mod documents;
mod error;
mod i18n;
mod settings;
mod updater;

use std::path::PathBuf;

use documents::{DirectoryEntry, SavedDocument, TextDocument};
use error::{AppError, CommandError, CommandResult};
use i18n::LocaleSelection;
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplicationBootstrap {
    version: String,
    runtime: &'static str,
    updater_enabled: bool,
    localization: LocaleSelection,
}

#[tauri::command(rename_all = "camelCase")]
async fn bootstrap_application(
    app: AppHandle,
    preferred_locales: Vec<String>,
) -> CommandResult<ApplicationBootstrap> {
    let version = app.package_info().version.to_string();
    let updater_enabled = updater::is_enabled(&app);
    run_blocking(move || {
        Ok(ApplicationBootstrap {
            version,
            runtime: "desktop",
            updater_enabled,
            localization: i18n::load_selection(&app, &preferred_locales)?,
        })
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
async fn refresh_locales(
    app: AppHandle,
    preferred_locales: Vec<String>,
) -> CommandResult<LocaleSelection> {
    run_blocking(move || i18n::load_selection(&app, &preferred_locales)).await
}

#[tauri::command(rename_all = "camelCase")]
async fn set_language_preference(
    app: AppHandle,
    preference: String,
    preferred_locales: Vec<String>,
) -> CommandResult<LocaleSelection> {
    run_blocking(move || i18n::set_preference(&app, preference, &preferred_locales)).await
}

#[tauri::command]
fn open_locale_directory(app: AppHandle) -> CommandResult<()> {
    let directory = i18n::locale_directory(&app)?;
    i18n::ensure_locale_directory(&directory)?;
    app.opener()
        .open_path(directory.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| AppError::Runtime(error.to_string()))?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
async fn read_text_file(path: String) -> CommandResult<TextDocument> {
    run_blocking(move || documents::read_text_file(PathBuf::from(path))).await
}

#[tauri::command(rename_all = "camelCase")]
async fn write_text_file(path: String, content: String) -> CommandResult<SavedDocument> {
    run_blocking(move || documents::write_text_file(PathBuf::from(path), content)).await
}

#[tauri::command(rename_all = "camelCase")]
async fn list_directory(path: String) -> CommandResult<Vec<DirectoryEntry>> {
    run_blocking(move || documents::list_directory(PathBuf::from(path))).await
}

async fn run_blocking<T, Operation>(operation: Operation) -> CommandResult<T>
where
    T: Send + 'static,
    Operation: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| CommandError::from(AppError::Runtime(error.to_string())))?
        .map_err(CommandError::from)
}

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init());
    let builder = updater::attach(builder);

    builder
        .invoke_handler(tauri::generate_handler![
            bootstrap_application,
            refresh_locales,
            set_language_preference,
            open_locale_directory,
            read_text_file,
            write_text_file,
            list_directory,
        ])
        .run(tauri::generate_context!())?;

    Ok(())
}
