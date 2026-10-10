use std::collections::HashSet;

use url::Url;

use crate::sideral_extensions::{
    error::ExtensionError,
    protocol::{PreviewElement, PreviewNode},
};

const MAX_CONTENT_BYTES: usize = 192 * 1024;
const MAX_NODES: usize = 10_000;
const MAX_DEPTH: usize = 24;
const MAX_KEY_BYTES: usize = 256;
const MAX_ATTRIBUTE_BYTES: usize = 4 * 1024;
const MAX_STYLE_BYTES: usize = 256;
const MAX_LIST_START: u32 = 1_000_000;
const TAGS: &[&str] = &[
    "a",
    "blockquote",
    "br",
    "code",
    "del",
    "div",
    "em",
    "figcaption",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "li",
    "ol",
    "p",
    "pre",
    "span",
    "strong",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul",
];
const STYLE_PROPERTIES: &[&str] = &[
    "backgroundColor",
    "border",
    "borderBottom",
    "borderInlineStart",
    "borderRadius",
    "borderCollapse",
    "borderSpacing",
    "color",
    "display",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "height",
    "letterSpacing",
    "lineHeight",
    "listStyleType",
    "margin",
    "marginTop",
    "marginBottom",
    "maxWidth",
    "overflow",
    "overflowX",
    "padding",
    "paddingBottom",
    "paddingInlineStart",
    "textAlign",
    "textDecoration",
    "whiteSpace",
    "width",
];
const STYLE_FUNCTIONS: &[&str] = &[
    "calc", "clamp", "min", "max", "rgb", "rgba", "hsl", "hsla", "var",
];

pub(super) fn validate_preview_content(content: &[PreviewNode]) -> Result<(), ExtensionError> {
    let bytes = serde_json::to_vec(content)
        .map_err(|error| invalid(format!("invalid preview content: {error}")))?;
    if bytes.len() > MAX_CONTENT_BYTES {
        return Err(invalid("preview content exceeds its byte limit"));
    }
    validate_nodes(content, 0, &mut 0)
}

fn validate_nodes(
    nodes: &[PreviewNode],
    depth: usize,
    count: &mut usize,
) -> Result<(), ExtensionError> {
    if depth > MAX_DEPTH {
        return Err(invalid("preview content exceeds its depth limit"));
    }
    let mut keys = HashSet::new();
    for node in nodes {
        *count += 1;
        if *count > MAX_NODES {
            return Err(invalid("preview content exceeds its node limit"));
        }
        match node {
            PreviewNode::Text(text) => validate_text(text, MAX_CONTENT_BYTES)?,
            PreviewNode::Element(element) => {
                validate_text(&element.key, MAX_KEY_BYTES)?;
                if element.key.is_empty() || !keys.insert(&element.key) {
                    return Err(invalid(
                        "preview keys must be nonempty and unique among siblings",
                    ));
                }
                if !TAGS.contains(&element.tag.as_str()) {
                    return Err(invalid("unsupported preview element"));
                }
                if matches!(element.tag.as_str(), "br" | "hr") && !element.children.is_empty() {
                    return Err(invalid("void preview elements cannot contain children"));
                }
                validate_element(element)?;
                validate_nodes(&element.children, depth + 1, count)?;
            }
        }
    }
    Ok(())
}

fn validate_element(element: &PreviewElement) -> Result<(), ExtensionError> {
    if let Some(attributes) = &element.attributes {
        for text in [&attributes.href, &attributes.title, &attributes.language]
            .into_iter()
            .flatten()
        {
            validate_text(text, MAX_ATTRIBUTE_BYTES)?;
        }
        if attributes.language.is_some() && element.tag != "code" {
            return Err(invalid(
                "preview language is supported only on code elements",
            ));
        }
        if let Some(start) = attributes.start
            && (element.tag != "ol" || start > MAX_LIST_START)
        {
            return Err(invalid("invalid preview list start"));
        }
        if let Some(href) = &attributes.href
            && (element.tag != "a" || !is_preview_link(href))
        {
            return Err(invalid("invalid preview link"));
        }
    }
    for (property, value) in &element.style {
        validate_text(value, MAX_STYLE_BYTES)?;
        if !STYLE_PROPERTIES.contains(&property.as_str()) || !is_style_value(value) {
            return Err(invalid("unsupported preview style"));
        }
    }
    Ok(())
}

fn is_preview_link(href: &str) -> bool {
    href.starts_with('#')
        || Url::parse(href).is_ok_and(|url| {
            matches!(url.scheme(), "file" | "http" | "https")
                && url.username().is_empty()
                && url.password().is_none()
        })
}

fn is_style_value(value: &str) -> bool {
    if value.is_empty()
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || character.is_ascii_whitespace()
                || "#%,.()-".contains(character)
        })
    {
        return false;
    }
    for (index, character) in value.char_indices() {
        if character == '(' {
            let prefix = value[..index].trim_end();
            let function = prefix
                .rsplit(|character: char| !character.is_ascii_alphabetic())
                .next()
                .unwrap_or_default();
            if !STYLE_FUNCTIONS.contains(&function) {
                return false;
            }
        }
    }
    true
}

fn validate_text(value: &str, maximum: usize) -> Result<(), ExtensionError> {
    if value.len() > maximum || value.contains('\0') {
        return Err(invalid(
            "preview text must be bounded and contain no NUL bytes",
        ));
    }
    Ok(())
}

fn invalid(message: impl Into<String>) -> ExtensionError {
    ExtensionError::InvalidRequest(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_executable_elements_links_styles_and_duplicate_keys()
    -> Result<(), Box<dyn std::error::Error>> {
        for node in [
            json!({"key":"one","tag":"script","children":[]}),
            json!({"key":"one","tag":"a","children":[],"attributes":{"href":"javascript:alert(1)"}}),
            json!({"key":"one","tag":"div","children":[],"style":{"backgroundColor":"url(https://example.com)"}}),
            json!({"key":"one","tag":"div","children":[],"style":{"position":"fixed"}}),
        ] {
            let node: PreviewNode = serde_json::from_value(node)?;
            assert!(validate_preview_content(&[node]).is_err());
        }
        let node: PreviewNode = serde_json::from_value(
            json!({"key":"one","tag":"p","children":["content"],"style":{"padding":"clamp(24px, 6vw, 72px)"}}),
        )?;
        assert!(validate_preview_content(std::slice::from_ref(&node)).is_ok());
        assert!(validate_preview_content(&[node.clone(), node]).is_err());
        Ok(())
    }

    #[test]
    fn rejects_oversized_and_deep_preview_trees() {
        assert!(
            validate_preview_content(&[PreviewNode::Text("x".repeat(MAX_CONTENT_BYTES))]).is_err()
        );
        let mut node = PreviewNode::Text("content".to_owned());
        for _ in 0..=MAX_DEPTH {
            node = PreviewNode::Element(PreviewElement {
                key: "nested".to_owned(),
                tag: "div".to_owned(),
                children: vec![node],
                attributes: None,
                style: Default::default(),
            });
        }
        assert!(validate_preview_content(&[node]).is_err());
    }
}
