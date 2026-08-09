mod desktop_integration;
mod documents;
mod error;
mod extension_systems;
mod external_links;
mod i18n;
mod json_schemas;
mod settings;
mod sideral_extensions;
mod updater;

use std::path::PathBuf;

use desktop_integration::{DesktopPreferences, DesktopPreferencesState};
use documents::{DirectoryEntry, SavedDocument, TextDocument};
use error::{AppError, CommandError, CommandResult};
use i18n::LocaleSelection;
use json_schemas::{
    JsonSchemaResolution, JsonSchemaState, JsonSchemaTrustScope, JsonSchemaTrustSettings,
};
use serde::Serialize;
use sideral_extensions::SideralExtensionState;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplicationBootstrap {
    version: String,
    runtime: &'static str,
    updater_enabled: bool,
    desktop_preferences: DesktopPreferences,
    localization: LocaleSelection,
}

#[tauri::command(rename_all = "camelCase")]
async fn bootstrap_application(
    app: AppHandle,
    desktop_preferences: State<'_, DesktopPreferencesState>,
    preferred_locales: Vec<String>,
) -> CommandResult<ApplicationBootstrap> {
    let version = app.package_info().version.to_string();
    let updater_enabled = updater::is_enabled(&app);
    let desktop_preferences = desktop_preferences.current()?;
    run_blocking(move || {
        Ok(ApplicationBootstrap {
            version,
            runtime: "desktop",
            updater_enabled,
            desktop_preferences,
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
fn open_external_url(app: AppHandle, url: String) -> CommandResult<()> {
    external_links::open(&app, &url).map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
async fn read_text_file(path: String) -> CommandResult<TextDocument> {
    run_blocking(move || documents::read_text_file(PathBuf::from(path))).await
}

#[tauri::command(rename_all = "camelCase")]
async fn create_text_file(directory: String, name: String) -> CommandResult<TextDocument> {
    run_blocking(move || documents::create_text_file(PathBuf::from(directory), name)).await
}

#[tauri::command(rename_all = "camelCase")]
async fn write_text_file(path: String, content: String) -> CommandResult<SavedDocument> {
    run_blocking(move || documents::write_text_file(PathBuf::from(path), content)).await
}

#[tauri::command(rename_all = "camelCase")]
async fn list_directory(path: String) -> CommandResult<Vec<DirectoryEntry>> {
    run_blocking(move || documents::list_directory(PathBuf::from(path))).await
}

#[tauri::command(rename_all = "camelCase")]
async fn validate_sideral_extension_manifest(
    source: String,
) -> CommandResult<sideral_extension_core::ExtensionInspection> {
    run_blocking(move || extension_systems::validate_sideral_manifest(&source)).await
}

#[tauri::command(rename_all = "camelCase")]
async fn inspect_vscode_legacy_manifest(
    source: String,
) -> CommandResult<vscode_legacy_core::LegacyInspection> {
    run_blocking(move || extension_systems::inspect_legacy_manifest(&source)).await
}

#[tauri::command(rename_all = "camelCase")]
async fn resolve_json_schema(
    state: State<'_, JsonSchemaState>,
    schema_uri: String,
    document_path: Option<String>,
    workspace_root: Option<String>,
) -> CommandResult<JsonSchemaResolution> {
    state
        .resolve(schema_uri, document_path, workspace_root)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
fn json_schema_trust_settings(
    state: State<'_, JsonSchemaState>,
) -> CommandResult<JsonSchemaTrustSettings> {
    state.trust_settings().map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
fn trust_json_schema_location(
    state: State<'_, JsonSchemaState>,
    uri: String,
    scope: JsonSchemaTrustScope,
) -> CommandResult<JsonSchemaTrustSettings> {
    state
        .trust_location(&uri, scope)
        .map_err(CommandError::from)
}

#[tauri::command(rename_all = "camelCase")]
fn revoke_json_schema_trust(
    state: State<'_, JsonSchemaState>,
    value: String,
    scope: JsonSchemaTrustScope,
) -> CommandResult<JsonSchemaTrustSettings> {
    state
        .revoke_trust(&value, scope)
        .map_err(CommandError::from)
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
    let context = tauri::generate_context!();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![desktop_integration::MINIMIZED_STARTUP_ARGUMENT]),
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init());
    let builder = if updater::is_configured(context.config()) {
        updater::attach(builder)
    } else {
        builder
    };

    builder
        .setup(|app| {
            let desktop_preferences = DesktopPreferencesState::load(app.handle())?;
            if !app.manage(desktop_preferences) {
                return Err(AppError::Runtime(
                    "desktop preferences state is already managed".to_owned(),
                )
                .into());
            }

            let json_schemas = JsonSchemaState::load(app.handle())?;
            if !app.manage(json_schemas) {
                return Err(
                    AppError::Runtime("JSON schema state is already managed".to_owned()).into(),
                );
            }

            let sideral_extensions = SideralExtensionState::load(app.handle())?;
            if !app.manage(sideral_extensions) {
                return Err(AppError::Runtime(
                    "Sideral extension state is already managed".to_owned(),
                )
                .into());
            }

            desktop_integration::setup_tray_icon(app.handle())?;
            let main_window = app
                .get_webview_window("main")
                .ok_or_else(|| AppError::Runtime("main window is unavailable".to_owned()))?;
            desktop_integration::apply_initial_window_state(&main_window)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap_application,
            desktop_integration::preferences::save_desktop_preferences,
            refresh_locales,
            set_language_preference,
            open_locale_directory,
            open_external_url,
            read_text_file,
            create_text_file,
            write_text_file,
            list_directory,
            validate_sideral_extension_manifest,
            inspect_vscode_legacy_manifest,
            resolve_json_schema,
            json_schema_trust_settings,
            trust_json_schema_location,
            revoke_json_schema_trust,
            sideral_extensions::initialize_extension_system,
            sideral_extensions::connect_extension_client,
            sideral_extensions::disconnect_extension_client,
            sideral_extensions::connect_extension_host,
            sideral_extensions::execute_extension_command,
            sideral_extensions::activate_extension_event,
            sideral_extensions::extension_host_event,
            sideral_extensions::extension_host_bundle,
            sideral_extensions::extension_broker_request,
            sideral_extensions::cancel_extension_broker_request,
            sideral_extensions::set_extension_workspace,
            sideral_extensions::inspect_extension_package,
            sideral_extensions::install_extension_package,
            sideral_extensions::set_extension_enabled,
            sideral_extensions::restart_extension,
            sideral_extensions::rollback_extension,
            sideral_extensions::uninstall_extension,
        ])
        .on_window_event(|window, event| {
            sideral_extensions::handle_window_event(window, event);
            desktop_integration::handle_main_window_event(window, event);
        })
        .run(context)?;

    Ok(())
}
