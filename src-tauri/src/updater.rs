use serde_json::Value;
use tauri::{AppHandle, Builder as TauriBuilder, Wry};

pub fn is_enabled(app: &AppHandle) -> bool {
    is_configured(app.config())
}

pub fn is_configured(configuration: &tauri::utils::config::Config) -> bool {
    has_required_fields(configuration.plugins.0.get("updater"))
}

fn has_required_fields(configuration: Option<&Value>) -> bool {
    let Some(configuration) = configuration else {
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::has_required_fields;

    #[test]
    fn requires_a_public_key_and_at_least_one_endpoint() {
        assert!(!has_required_fields(None));
        assert!(!has_required_fields(Some(&json!(null))));
        assert!(!has_required_fields(Some(&json!({}))));
        assert!(!has_required_fields(Some(&json!({
            "pubkey": "public-key",
            "endpoints": []
        }))));
        assert!(has_required_fields(Some(&json!({
            "pubkey": "public-key",
            "endpoints": ["https://updates.example.com/latest.json"]
        }))));
    }
}
