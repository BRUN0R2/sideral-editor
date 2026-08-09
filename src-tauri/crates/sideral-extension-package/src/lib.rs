#![forbid(unsafe_code)]

mod archive;
mod builder;
mod error;
mod signature;

pub use archive::{ValidatedExtensionPackage, validate_package_bytes};
pub use builder::build_signed_package;
pub use error::PackageError;
pub use signature::{
    PackageSignature, PublisherIdentity, SignedFile, sha256_hex, signature_payload,
};

use signature::verify_signature;

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        error::Error,
        io::{Cursor, Write},
    };

    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use ed25519_dalek::{Signer, SigningKey};
    use zip::{ZipWriter, write::SimpleFileOptions};

    use super::{
        PackageError, PackageSignature, SignedFile, build_signed_package, sha256_hex,
        signature_payload, validate_package_bytes,
    };

    type TestResult = Result<(), Box<dyn Error>>;

    const MANIFEST: &str = r#"{
        "manifestVersion": 1,
        "apiVersion": 1,
        "id": "sample.hello",
        "displayName": "Hello",
        "version": "1.0.0",
        "engines": { "sideral": "^0.1.0" },
        "runtime": { "kind": "worker", "entry": "dist/extension.mjs" },
        "contributes": {
            "commands": [{ "id": "sample.hello.run", "title": "Run Hello" }]
        }
    }"#;
    const BUNDLE: &[u8] = b"self.onmessage = () => undefined;";

    #[test]
    fn validates_a_signed_package() -> TestResult {
        let package = package_bytes(BUNDLE, BUNDLE)?;
        let validated = validate_package_bytes(&package)?;

        assert_eq!(validated.manifest.id, "sample.hello");
        assert_eq!(validated.bundle, BUNDLE);
        assert_eq!(validated.publisher.publisher, "sample");
        Ok(())
    }

    #[test]
    fn rejects_content_changed_after_signing() -> TestResult {
        let package = package_bytes(BUNDLE, b"malicious replacement")?;
        let result = validate_package_bytes(&package);

        assert!(matches!(result, Err(PackageError::Signature(_))));
        Ok(())
    }

    #[test]
    fn rejects_parent_directory_entries() -> TestResult {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer.start_file("../manifest.json", SimpleFileOptions::default())?;
        writer.write_all(MANIFEST.as_bytes())?;
        let package = writer.finish()?.into_inner();

        assert!(matches!(
            validate_package_bytes(&package),
            Err(PackageError::Manifest(_) | PackageError::Invalid(_))
        ));
        Ok(())
    }

    #[test]
    fn rejects_windows_trailing_dot_paths() {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let files = BTreeMap::from([
            ("assets/name.".to_owned(), Vec::new()),
            ("dist/extension.mjs".to_owned(), BUNDLE.to_vec()),
            ("manifest.json".to_owned(), MANIFEST.as_bytes().to_vec()),
        ]);

        assert!(matches!(
            build_signed_package("sample", &signing_key, files),
            Err(PackageError::Invalid(_))
        ));
    }

    fn package_bytes(
        signed_bundle: &[u8],
        archived_bundle: &[u8],
    ) -> Result<Vec<u8>, Box<dyn Error>> {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let public_key = signing_key.verifying_key().to_bytes();
        let public_key_base64 = STANDARD.encode(public_key);
        let key_id = sha256_hex(&public_key);

        let signed_contents = BTreeMap::from([
            ("dist/extension.mjs".to_owned(), signed_bundle.to_vec()),
            ("manifest.json".to_owned(), MANIFEST.as_bytes().to_vec()),
        ]);
        let digests = signed_contents
            .iter()
            .map(|(path, content)| (path.clone(), sha256_hex(content)))
            .collect::<BTreeMap<_, _>>();
        let signature = signing_key.sign(&signature_payload("sample", &key_id, &digests));
        let signature_document = PackageSignature {
            schema_version: 1,
            publisher: "sample".to_owned(),
            key_id,
            public_key: public_key_base64,
            files: digests
                .into_iter()
                .map(|(path, sha256)| SignedFile { path, sha256 })
                .collect(),
            signature: STANDARD.encode(signature.to_bytes()),
        };

        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default();
        writer.start_file("manifest.json", options)?;
        writer.write_all(MANIFEST.as_bytes())?;
        writer.start_file("dist/extension.mjs", options)?;
        writer.write_all(archived_bundle)?;
        writer.start_file("signature.json", options)?;
        writer.write_all(&serde_json::to_vec(&signature_document)?)?;
        Ok(writer.finish()?.into_inner())
    }
}
