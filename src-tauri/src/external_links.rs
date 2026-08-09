use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::error::{AppError, AppResult};

pub fn open(app: &AppHandle, value: &str) -> AppResult<()> {
    let url = parse_web_url(value)?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|error| AppError::Runtime(format!("could not open the external URL: {error}")))
}

fn parse_web_url(value: &str) -> AppResult<Url> {
    let url = Url::parse(value)
        .map_err(|error| AppError::InvalidExternalUrl(format!("{value}: {error}")))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(AppError::InvalidExternalUrl(
            "only absolute HTTP and HTTPS URLs are supported".to_owned(),
        ));
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use std::error::Error;

    use super::parse_web_url;

    type TestResult = Result<(), Box<dyn Error>>;

    #[test]
    fn accepts_external_web_urls() -> TestResult {
        let url = parse_web_url("https://json-schema.org/learn#documentation")?;

        assert_eq!(url.as_str(), "https://json-schema.org/learn#documentation");
        Ok(())
    }

    #[test]
    fn rejects_non_web_and_relative_urls() {
        for value in [
            "file:///C:/Windows/System32/calc.exe",
            "command:workbench.action.openSettings",
            "javascript:alert(1)",
            "../documentation.html",
        ] {
            assert!(parse_web_url(value).is_err());
        }
    }
}
