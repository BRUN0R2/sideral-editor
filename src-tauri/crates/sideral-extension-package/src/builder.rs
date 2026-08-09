use std::{
    collections::BTreeMap,
    io::{Cursor, Write},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

use crate::{
    PackageError, PackageSignature, SignedFile, sha256_hex, signature_payload,
    validate_package_bytes,
};

const SIGNATURE_PATH: &str = "signature.json";

pub fn build_signed_package(
    publisher: &str,
    signing_key: &SigningKey,
    files: BTreeMap<String, Vec<u8>>,
) -> Result<Vec<u8>, PackageError> {
    if files.is_empty() || files.contains_key(SIGNATURE_PATH) {
        return Err(PackageError::invalid(
            "package files must be non-empty and cannot provide signature.json",
        ));
    }
    let digests = files
        .iter()
        .map(|(path, content)| (path.clone(), sha256_hex(content)))
        .collect::<BTreeMap<_, _>>();
    let public_key = signing_key.verifying_key().to_bytes();
    let public_key_base64 = STANDARD.encode(public_key);
    let key_id = sha256_hex(&public_key);
    let signature = signing_key.sign(&signature_payload(publisher, &key_id, &digests));
    let signature_document = PackageSignature {
        schema_version: 1,
        publisher: publisher.to_owned(),
        key_id,
        public_key: public_key_base64,
        files: digests
            .into_iter()
            .map(|(path, sha256)| SignedFile { path, sha256 })
            .collect(),
        signature: STANDARD.encode(signature.to_bytes()),
    };
    let signature_bytes = serde_json::to_vec_pretty(&signature_document)
        .map_err(|error| PackageError::signature(error.to_string()))?;

    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);
    for (path, content) in files {
        writer.start_file(path, options)?;
        writer.write_all(&content)?;
    }
    writer.start_file(SIGNATURE_PATH, options)?;
    writer.write_all(&signature_bytes)?;
    let package = writer.finish()?.into_inner();
    validate_package_bytes(&package)?;
    Ok(package)
}
