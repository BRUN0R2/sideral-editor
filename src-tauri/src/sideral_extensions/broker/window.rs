use std::{collections::HashMap, sync::atomic::Ordering};

use serde_json::Value;
use sideral_extension_core::ExtensionManifest;
use url::Url;

use super::preview::validate_preview_content;
use super::{
    CapabilityBroker, OutputResource, PreviewDocumentPayload, PreviewResource,
    PreviewUpdatePayload, lock,
};
use crate::sideral_extensions::{
    error::ExtensionError,
    protocol::{
        ExtensionClientInstruction, MessageSeverity, OutputChannelView, PreviewAppearance,
        PreviewDocumentView, PreviewNode,
    },
    service::SideralExtensionState,
};

const MAX_MESSAGE_BYTES: usize = 4 * 1024;
const MAX_OUTPUT_CHANNELS_PER_EXTENSION: usize = 32;
const MAX_OUTPUT_CHANNEL_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_APPEND_BYTES: usize = 64 * 1024;
const MAX_PREVIEW_PANELS_PER_EXTENSION: usize = 8;
const DEFAULT_SCROLLBAR_TRACK_SIZE: u16 = 14;
const DEFAULT_SCROLLBAR_THUMB_SIZE: u16 = 10;
const DEFAULT_SCROLLBAR_BUTTON_SIZE: u16 = 22;
const DEFAULT_SCROLLBAR_ARROW_SIZE: u16 = 11;
const DEFAULT_SCROLLBAR_ARROW_HEIGHT: u16 = 6;

impl CapabilityBroker {
    pub fn output_views(&self) -> Result<Vec<OutputChannelView>, ExtensionError> {
        let outputs = lock(&self.shared.outputs, "extension output channels")?;
        let mut views = outputs
            .iter()
            .map(|(resource_id, output)| output_view(resource_id, output))
            .collect::<Vec<_>>();
        views.sort_by(|left, right| left.resource_id.cmp(&right.resource_id));
        Ok(views)
    }

    pub fn visible_preview_views(&self) -> Result<Vec<PreviewDocumentView>, ExtensionError> {
        let previews = lock(&self.shared.previews, "extension previews")?;
        let mut views = previews
            .iter()
            .filter(|(_, preview)| preview.visible)
            .map(|(resource_id, preview)| preview_view(resource_id, preview))
            .collect::<Vec<_>>();
        views.sort_by(|left, right| left.resource_id.cmp(&right.resource_id));
        Ok(views)
    }

    pub fn dismiss_preview(
        &self,
        state: &SideralExtensionState,
        resource_id: &str,
        expected_source_uri: Option<&str>,
    ) -> Result<(), ExtensionError> {
        let view = {
            let mut previews = lock(&self.shared.previews, "extension previews")?;
            let preview = previews
                .get_mut(resource_id)
                .ok_or_else(|| ExtensionError::NotFound(resource_id.to_owned()))?;
            if !preview_matches_dismissal(preview, expected_source_uri) {
                return Ok(());
            }
            preview.visible = false;
            preview_view(resource_id, preview)
        };
        state.send_client_instruction(ExtensionClientInstruction::PreviewChanged {
            preview: Box::new(view),
        })
    }

    pub(super) fn create_output(
        &self,
        manifest: &ExtensionManifest,
        name: String,
    ) -> Result<Value, ExtensionError> {
        validate_text("output channel name", &name, 128)?;
        let mut outputs = lock(&self.shared.outputs, "extension output channels")?;
        if outputs
            .values()
            .filter(|output| output.extension_id == manifest.id)
            .count()
            >= MAX_OUTPUT_CHANNELS_PER_EXTENSION
        {
            return Err(ExtensionError::Conflict(format!(
                "extension {} exceeded its {MAX_OUTPUT_CHANNELS_PER_EXTENSION}-channel output limit",
                manifest.id
            )));
        }
        let sequence = self.shared.next_output_id.fetch_add(1, Ordering::Relaxed);
        let resource_id = format!("{}:{sequence}", manifest.id);
        outputs.insert(
            resource_id.clone(),
            OutputResource {
                extension_id: manifest.id.clone(),
                name,
                content: String::new(),
                reveal_sequence: 0,
            },
        );
        Ok(Value::String(resource_id))
    }

    pub(super) fn append_output(
        &self,
        manifest: &ExtensionManifest,
        resource_id: &str,
        value: &str,
    ) -> Result<Value, ExtensionError> {
        if value.len() > MAX_OUTPUT_APPEND_BYTES {
            return Err(ExtensionError::InvalidRequest(format!(
                "output append exceeds {MAX_OUTPUT_APPEND_BYTES} bytes"
            )));
        }
        let mut outputs = lock(&self.shared.outputs, "extension output channels")?;
        let output = owned_output_mut(&mut outputs, &manifest.id, resource_id)?;
        if output.content.len().saturating_add(value.len()) > MAX_OUTPUT_CHANNEL_BYTES {
            return Err(ExtensionError::InvalidRequest(format!(
                "output channel exceeds {MAX_OUTPUT_CHANNEL_BYTES} bytes"
            )));
        }
        output.content.push_str(value);
        Ok(Value::Null)
    }

    pub(super) fn clear_output(
        &self,
        manifest: &ExtensionManifest,
        resource_id: &str,
    ) -> Result<Value, ExtensionError> {
        let mut outputs = lock(&self.shared.outputs, "extension output channels")?;
        owned_output_mut(&mut outputs, &manifest.id, resource_id)?
            .content
            .clear();
        Ok(Value::Null)
    }

    pub(super) fn show_output(
        &self,
        state: &SideralExtensionState,
        manifest: &ExtensionManifest,
        resource_id: &str,
    ) -> Result<Value, ExtensionError> {
        let view = {
            let mut outputs = lock(&self.shared.outputs, "extension output channels")?;
            let output = owned_output_mut(&mut outputs, &manifest.id, resource_id)?;
            advance_output_reveal(output)?;
            output_view(resource_id, output)
        };
        state
            .send_client_instruction(ExtensionClientInstruction::OutputChanged { channel: view })?;
        Ok(Value::Null)
    }

    pub(super) fn flush_output(
        &self,
        state: &SideralExtensionState,
        manifest: &ExtensionManifest,
        resource_id: &str,
    ) -> Result<Value, ExtensionError> {
        let view = {
            let outputs = lock(&self.shared.outputs, "extension output channels")?;
            let output = owned_output(&outputs, &manifest.id, resource_id)?;
            output_view(resource_id, output)
        };
        state
            .send_client_instruction(ExtensionClientInstruction::OutputChanged { channel: view })?;
        Ok(Value::Null)
    }

    pub(super) fn dispose_output(
        &self,
        state: &SideralExtensionState,
        manifest: &ExtensionManifest,
        resource_id: &str,
    ) -> Result<Value, ExtensionError> {
        let mut outputs = lock(&self.shared.outputs, "extension output channels")?;
        owned_output(&outputs, &manifest.id, resource_id)?;
        outputs.remove(resource_id);
        drop(outputs);
        state.send_client_instruction(ExtensionClientInstruction::OutputDisposed {
            resource_id: resource_id.to_owned(),
        })?;
        Ok(Value::Null)
    }

    pub(super) fn create_preview(
        &self,
        manifest: &ExtensionManifest,
        payload: PreviewDocumentPayload,
    ) -> Result<Value, ExtensionError> {
        validate_preview_document(
            &payload.title,
            &payload.content,
            payload.source_uri.as_deref(),
            payload.appearance.as_ref(),
        )?;
        let mut previews = lock(&self.shared.previews, "extension previews")?;
        if previews
            .values()
            .filter(|preview| preview.extension_id == manifest.id)
            .count()
            >= MAX_PREVIEW_PANELS_PER_EXTENSION
        {
            return Err(ExtensionError::Conflict(format!(
                "extension {} exceeded its {MAX_PREVIEW_PANELS_PER_EXTENSION}-panel preview limit",
                manifest.id
            )));
        }
        let sequence = self.shared.next_preview_id.fetch_add(1, Ordering::Relaxed);
        let resource_id = format!("preview:{}:{sequence}", manifest.id);
        previews.insert(
            resource_id.clone(),
            PreviewResource {
                extension_id: manifest.id.clone(),
                title: payload.title,
                format: payload.format,
                content: payload.content,
                source_uri: payload.source_uri,
                appearance: payload.appearance,
                visible: false,
            },
        );
        Ok(Value::String(resource_id))
    }

    pub(super) fn update_preview(
        &self,
        state: &SideralExtensionState,
        manifest: &ExtensionManifest,
        payload: PreviewUpdatePayload,
    ) -> Result<Value, ExtensionError> {
        validate_preview_document(
            &payload.title,
            &payload.content,
            payload.source_uri.as_deref(),
            payload.appearance.as_ref(),
        )?;
        let view = {
            let mut previews = lock(&self.shared.previews, "extension previews")?;
            let preview = owned_preview_mut(&mut previews, &manifest.id, &payload.resource_id)?;
            preview.title = payload.title;
            preview.format = payload.format;
            preview.content = payload.content;
            preview.source_uri = payload.source_uri;
            preview.appearance = payload.appearance;
            preview_view(&payload.resource_id, preview)
        };
        if view.visible {
            state.send_client_instruction(ExtensionClientInstruction::PreviewChanged {
                preview: Box::new(view),
            })?;
        }
        Ok(Value::Null)
    }

    pub(super) fn set_preview_visibility(
        &self,
        state: &SideralExtensionState,
        manifest: &ExtensionManifest,
        resource_id: &str,
        visible: bool,
    ) -> Result<bool, ExtensionError> {
        let views = {
            let mut previews = lock(&self.shared.previews, "extension previews")?;
            owned_preview(&previews, &manifest.id, resource_id)?;
            let mut views = Vec::new();
            if visible {
                for (candidate_id, preview) in previews.iter_mut() {
                    if preview.visible && candidate_id != resource_id {
                        preview.visible = false;
                        views.push(preview_view(candidate_id, preview));
                    }
                }
            }
            let preview = owned_preview_mut(&mut previews, &manifest.id, resource_id)?;
            if preview.visible != visible {
                preview.visible = visible;
                views.push(preview_view(resource_id, preview));
            }
            views
        };
        for view in views {
            state.send_client_instruction(ExtensionClientInstruction::PreviewChanged {
                preview: Box::new(view),
            })?;
        }
        Ok(visible)
    }

    pub(super) fn toggle_preview(
        &self,
        state: &SideralExtensionState,
        manifest: &ExtensionManifest,
        resource_id: &str,
    ) -> Result<bool, ExtensionError> {
        let visible = {
            let previews = lock(&self.shared.previews, "extension previews")?;
            !owned_preview(&previews, &manifest.id, resource_id)?.visible
        };
        self.set_preview_visibility(state, manifest, resource_id, visible)
    }

    pub(super) fn dispose_preview(
        &self,
        state: &SideralExtensionState,
        manifest: &ExtensionManifest,
        resource_id: &str,
    ) -> Result<Value, ExtensionError> {
        let mut previews = lock(&self.shared.previews, "extension previews")?;
        owned_preview(&previews, &manifest.id, resource_id)?;
        previews.remove(resource_id);
        drop(previews);
        state.send_client_instruction(ExtensionClientInstruction::PreviewDisposed {
            resource_id: resource_id.to_owned(),
        })?;
        Ok(Value::Null)
    }
}

pub(super) fn send_message(
    state: &SideralExtensionState,
    manifest: &ExtensionManifest,
    severity: MessageSeverity,
    message: String,
) -> Result<Value, ExtensionError> {
    validate_text("message", &message, MAX_MESSAGE_BYTES)?;
    state.send_client_instruction(ExtensionClientInstruction::ShowMessage {
        extension_id: manifest.id.clone(),
        severity,
        message,
    })?;
    Ok(Value::Null)
}

fn output_view(resource_id: &str, output: &OutputResource) -> OutputChannelView {
    OutputChannelView {
        resource_id: resource_id.to_owned(),
        extension_id: output.extension_id.clone(),
        name: output.name.clone(),
        content: output.content.clone(),
        reveal_sequence: output.reveal_sequence,
    }
}

fn advance_output_reveal(output: &mut OutputResource) -> Result<(), ExtensionError> {
    output.reveal_sequence = output.reveal_sequence.checked_add(1).ok_or_else(|| {
        ExtensionError::Conflict("output channel reveal sequence was exhausted".to_owned())
    })?;
    Ok(())
}

fn owned_output<'a>(
    outputs: &'a HashMap<String, OutputResource>,
    extension_id: &str,
    resource_id: &str,
) -> Result<&'a OutputResource, ExtensionError> {
    let output = outputs.get(resource_id).ok_or_else(|| {
        ExtensionError::InvalidRequest(format!("output channel {resource_id} does not exist"))
    })?;
    if output.extension_id != extension_id {
        return Err(ExtensionError::PermissionDenied(
            "output channel belongs to another extension".to_owned(),
        ));
    }
    Ok(output)
}

fn owned_output_mut<'a>(
    outputs: &'a mut HashMap<String, OutputResource>,
    extension_id: &str,
    resource_id: &str,
) -> Result<&'a mut OutputResource, ExtensionError> {
    let output = outputs.get_mut(resource_id).ok_or_else(|| {
        ExtensionError::InvalidRequest(format!("output channel {resource_id} does not exist"))
    })?;
    if output.extension_id != extension_id {
        return Err(ExtensionError::PermissionDenied(
            "output channel belongs to another extension".to_owned(),
        ));
    }
    Ok(output)
}

pub(super) fn validate_preview_document(
    title: &str,
    content: &[PreviewNode],
    source_uri: Option<&str>,
    appearance: Option<&PreviewAppearance>,
) -> Result<(), ExtensionError> {
    validate_text("preview title", title, 160)?;
    validate_preview_content(content)?;
    if let Some(source_uri) = source_uri {
        if source_uri.len() > 4_096 {
            return Err(ExtensionError::InvalidRequest(
                "preview source URI exceeds 4096 bytes".to_owned(),
            ));
        }
        let parsed = Url::parse(source_uri).map_err(|error| {
            ExtensionError::InvalidRequest(format!("invalid preview source URI: {error}"))
        })?;
        if !matches!(parsed.scheme(), "file" | "untitled")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(ExtensionError::InvalidRequest(
                "preview source must be a clean file or untitled URI".to_owned(),
            ));
        }
    }
    validate_preview_appearance(appearance)?;
    Ok(())
}

fn validate_preview_appearance(
    appearance: Option<&PreviewAppearance>,
) -> Result<(), ExtensionError> {
    let Some(scrollbar) = appearance.and_then(|appearance| appearance.scrollbar.as_ref()) else {
        return Ok(());
    };
    let track_size = scrollbar.track_size.unwrap_or(DEFAULT_SCROLLBAR_TRACK_SIZE);
    let thumb_size = scrollbar
        .thumb_size
        .unwrap_or(DEFAULT_SCROLLBAR_THUMB_SIZE.min(track_size));
    let button_size = scrollbar
        .button_size
        .unwrap_or(DEFAULT_SCROLLBAR_BUTTON_SIZE);
    let arrow_size = scrollbar.arrow_size.unwrap_or(
        DEFAULT_SCROLLBAR_ARROW_SIZE
            .min(track_size)
            .min(button_size),
    );
    let arrow_height = scrollbar.arrow_height.unwrap_or(
        DEFAULT_SCROLLBAR_ARROW_HEIGHT
            .min(arrow_size)
            .min(button_size),
    );
    if !(8..=32).contains(&track_size) {
        return Err(ExtensionError::InvalidRequest(
            "preview scrollbar trackSize must be between 8 and 32 pixels".to_owned(),
        ));
    }
    if !(4..=track_size).contains(&thumb_size) {
        return Err(ExtensionError::InvalidRequest(
            "preview scrollbar thumbSize must be between 4 pixels and trackSize".to_owned(),
        ));
    }
    if !(8..=32).contains(&button_size) {
        return Err(ExtensionError::InvalidRequest(
            "preview scrollbar buttonSize must be between 8 and 32 pixels".to_owned(),
        ));
    }
    if !(4..=track_size.min(button_size)).contains(&arrow_size) {
        return Err(ExtensionError::InvalidRequest(
            "preview scrollbar arrowSize must be between 4 pixels and the smaller trackSize or buttonSize"
                .to_owned(),
        ));
    }
    if !(3..=arrow_size.min(button_size)).contains(&arrow_height) {
        return Err(ExtensionError::InvalidRequest(
            "preview scrollbar arrowHeight must be between 3 pixels and the smaller arrowSize or buttonSize"
                .to_owned(),
        ));
    }
    if scrollbar.corner_radius.is_some_and(|radius| radius > 999) {
        return Err(ExtensionError::InvalidRequest(
            "preview scrollbar cornerRadius must be at most 999 pixels".to_owned(),
        ));
    }
    for (name, color) in [
        ("trackColor", scrollbar.track_color.as_deref()),
        ("thumbColor", scrollbar.thumb_color.as_deref()),
        ("thumbHoverColor", scrollbar.thumb_hover_color.as_deref()),
        ("thumbActiveColor", scrollbar.thumb_active_color.as_deref()),
        ("arrowColor", scrollbar.arrow_color.as_deref()),
        ("arrowHoverColor", scrollbar.arrow_hover_color.as_deref()),
        ("arrowActiveColor", scrollbar.arrow_active_color.as_deref()),
    ] {
        if let Some(color) = color {
            validate_preview_scrollbar_color(name, color)?;
        }
    }
    Ok(())
}

fn validate_preview_scrollbar_color(name: &str, color: &str) -> Result<(), ExtensionError> {
    let hexadecimal = color.strip_prefix('#').is_some_and(|digits| {
        matches!(digits.len(), 3 | 4 | 6 | 8) && digits.bytes().all(|byte| byte.is_ascii_hexdigit())
    });
    if color.eq_ignore_ascii_case("transparent") || hexadecimal {
        return Ok(());
    }
    Err(ExtensionError::InvalidRequest(format!(
        "preview scrollbar {name} must be transparent or a 3, 4, 6 or 8-digit hexadecimal color"
    )))
}

fn preview_view(resource_id: &str, preview: &PreviewResource) -> PreviewDocumentView {
    PreviewDocumentView {
        resource_id: resource_id.to_owned(),
        extension_id: preview.extension_id.clone(),
        title: preview.title.clone(),
        format: preview.format,
        content: preview.content.clone(),
        source_uri: preview.source_uri.clone(),
        appearance: preview.appearance.clone(),
        visible: preview.visible,
    }
}

pub(super) fn preview_matches_dismissal(
    preview: &PreviewResource,
    expected_source_uri: Option<&str>,
) -> bool {
    preview.visible && preview.source_uri.as_deref() == expected_source_uri
}

fn owned_preview<'a>(
    previews: &'a HashMap<String, PreviewResource>,
    extension_id: &str,
    resource_id: &str,
) -> Result<&'a PreviewResource, ExtensionError> {
    let preview = previews.get(resource_id).ok_or_else(|| {
        ExtensionError::InvalidRequest(format!("preview panel {resource_id} does not exist"))
    })?;
    if preview.extension_id != extension_id {
        return Err(ExtensionError::PermissionDenied(
            "preview panel belongs to another extension".to_owned(),
        ));
    }
    Ok(preview)
}

fn owned_preview_mut<'a>(
    previews: &'a mut HashMap<String, PreviewResource>,
    extension_id: &str,
    resource_id: &str,
) -> Result<&'a mut PreviewResource, ExtensionError> {
    let preview = previews.get_mut(resource_id).ok_or_else(|| {
        ExtensionError::InvalidRequest(format!("preview panel {resource_id} does not exist"))
    })?;
    if preview.extension_id != extension_id {
        return Err(ExtensionError::PermissionDenied(
            "preview panel belongs to another extension".to_owned(),
        ));
    }
    Ok(preview)
}

fn validate_text(kind: &str, value: &str, maximum_bytes: usize) -> Result<(), ExtensionError> {
    if value.is_empty()
        || value.trim() != value
        || value.len() > maximum_bytes
        || value.contains('\0')
    {
        return Err(ExtensionError::InvalidRequest(format!(
            "{kind} must be clean text between 1 and {maximum_bytes} bytes"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_reveal_sequence_is_monotonic_and_checked() {
        let mut output = OutputResource {
            extension_id: "acme.compiler".to_owned(),
            name: "Compiler".to_owned(),
            content: String::new(),
            reveal_sequence: 0,
        };

        assert!(advance_output_reveal(&mut output).is_ok());
        assert_eq!(output.reveal_sequence, 1);
        assert!(advance_output_reveal(&mut output).is_ok());
        assert_eq!(output.reveal_sequence, 2);

        output.reveal_sequence = u32::MAX;
        assert!(matches!(
            advance_output_reveal(&mut output),
            Err(ExtensionError::Conflict(_))
        ));
    }
}
