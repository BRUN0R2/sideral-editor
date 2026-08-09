use tauri::{Builder as TauriBuilder, Wry};

use tauri::AppHandle;

pub fn is_enabled(app: &AppHandle) -> bool {
    let Some(configuration) = app.config().plugins.0.get("updater") else {
        return false;
    };
    let Some(configuration) = configuration.as_object() else {
        return false;
    };
    let has_public_key = configuration
        .get("pubkey")
        .and_then(|value| value.as_str())
        .is_some_and(|value| !value.trim().is_empty());
    let has_endpoint = configuration
        .get("endpoints")
        .and_then(|value| value.as_array())
        .is_some_and(|values| !values.is_empty());
    has_public_key && has_endpoint
}

pub fn attach(builder: TauriBuilder<Wry>) -> TauriBuilder<Wry> {
    builder.plugin(tauri_plugin_updater::Builder::new().build())
}
