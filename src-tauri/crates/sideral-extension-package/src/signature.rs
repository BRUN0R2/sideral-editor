use std::collections::{BTreeMap, BTreeSet};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::PackageError;

const SIGNATURE_SCHEMA_VERSION: u8 = 1;
const SIGNATURE_DOMAIN: &[u8] = b"sideralx-signature-v1\n";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedFile {
    pub path: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageSignature {
    pub schema_version: u8,
    pub publisher: String,
    pub key_id: String,
    pub public_key: String,
    pub files: Vec<SignedFile>,
    pub signature: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublisherIdentity {
    pub publisher: String,
    pub key_id: String,
    pub public_key: String,
}

pub(crate) fn verify_signature(
    source: &[u8],
    files: &BTreeMap<String, Vec<u8>>,
    extension_id: &str,
) -> Result<PublisherIdentity, PackageError> {
    let document: PackageSignature = serde_json::from_slice(source)
        .map_err(|error| PackageError::signature(format!("signature.json is invalid: {error}")))?;
    if document.schema_version != SIGNATURE_SCHEMA_VERSION {
        return Err(PackageError::signature(format!(
            "signature schema version {} is unsupported",
            document.schema_version
        )));
    }
    validate_publisher(&document.publisher, extension_id)?;

    let public_key_bytes = STANDARD.decode(&document.public_key).map_err(|error| {
        PackageError::signature(format!("public key is not valid Base64: {error}"))
    })?;
    let public_key_array: [u8; 32] = public_key_bytes
        .try_into()
        .map_err(|_| PackageError::signature("Ed25519 public key must contain exactly 32 bytes"))?;
    let calculated_key_id = sha256_hex(&public_key_array);
    if document.key_id != calculated_key_id {
        return Err(PackageError::signature(
            "keyId does not match the SHA-256 digest of publicKey",
        ));
    }

    let declared_files = validate_file_digests(&document.files, files)?;
    let payload = signature_payload(&document.publisher, &document.key_id, &declared_files);
    let signature_bytes = STANDARD.decode(&document.signature).map_err(|error| {
        PackageError::signature(format!("signature is not valid Base64: {error}"))
    })?;
    let signature = Signature::from_slice(&signature_bytes).map_err(|error| {
        PackageError::signature(format!("signature has an invalid Ed25519 shape: {error}"))
    })?;
    let verifying_key = VerifyingKey::from_bytes(&public_key_array)
        .map_err(|error| PackageError::signature(format!("public key is invalid: {error}")))?;
    verifying_key
        .verify(&payload, &signature)
        .map_err(|error| PackageError::signature(format!("verification failed: {error}")))?;

    Ok(PublisherIdentity {
        publisher: document.publisher,
        key_id: document.key_id,
        public_key: document.public_key,
    })
}

fn validate_publisher(publisher: &str, extension_id: &str) -> Result<(), PackageError> {
    let valid = !publisher.is_empty()
        && publisher.len() <= 64
        && !publisher.starts_with('-')
        && !publisher.ends_with('-')
        && publisher
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if !valid {
        return Err(PackageError::signature(
            "publisher must use lowercase ASCII letters, digits or inner hyphens",
        ));
    }
    if !extension_id.starts_with(&format!("{publisher}.")) {
        return Err(PackageError::signature(format!(
            "extension id {extension_id} does not belong to publisher {publisher}"
        )));
    }
    Ok(())
}

fn validate_file_digests(
    declared: &[SignedFile],
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<BTreeMap<String, String>, PackageError> {
    let expected_paths = files.keys().cloned().collect::<BTreeSet<_>>();
    let mut declared_paths = BTreeSet::new();
    let mut digests = BTreeMap::new();
    for file in declared {
        if !declared_paths.insert(file.path.clone()) {
            return Err(PackageError::signature(format!(
                "duplicate signed file {}",
                file.path
            )));
        }
        let content = files.get(&file.path).ok_or_else(|| {
            PackageError::signature(format!("signed file {} is missing", file.path))
        })?;
        let actual = sha256_hex(content);
        if file.sha256 != actual {
            return Err(PackageError::signature(format!(
                "SHA-256 mismatch for {}",
                file.path
            )));
        }
        digests.insert(file.path.clone(), actual);
    }
    if declared_paths != expected_paths {
        return Err(PackageError::signature(
            "signature must cover every package file except signature.json",
        ));
    }
    Ok(digests)
}

pub fn signature_payload(
    publisher: &str,
    key_id: &str,
    files: &BTreeMap<String, String>,
) -> Vec<u8> {
    let mut payload = Vec::from(SIGNATURE_DOMAIN);
    append_field(&mut payload, "publisher", publisher);
    append_field(&mut payload, "keyId", key_id);
    for (path, digest) in files {
        append_field(&mut payload, path, digest);
    }
    payload
}

fn append_field(payload: &mut Vec<u8>, key: &str, value: &str) {
    payload.extend_from_slice(key.as_bytes());
    payload.push(0);
    payload.extend_from_slice(value.as_bytes());
    payload.push(b'\n');
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}
