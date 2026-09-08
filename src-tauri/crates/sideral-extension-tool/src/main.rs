#![forbid(unsafe_code)]

use std::{
    collections::{BTreeMap, VecDeque},
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use ed25519_dalek::SigningKey;
use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use sideral_extension_core::{
    assess_worker_bundle_size, parse_manifest_json, validate_package_path,
};
use sideral_extension_package::{build_signed_package, validate_package_bytes};
use tempfile::{NamedTempFile, TempDir};
use thiserror::Error;

const KEY_SCHEMA_VERSION: u8 = 1;
const MAX_KEY_FILE_BYTES: u64 = 16 * 1024;
const MAX_PROJECT_FILES: usize = 256;
const MANIFEST_PATH: &str = "manifest.json";
const SDK_INDEX_SOURCE: &str =
    include_str!("../../../../packages/sideral-extension-sdk/src/index.ts");
const SDK_MANIFEST_SOURCE: &str =
    include_str!("../../../../packages/sideral-extension-sdk/src/manifest.ts");
const SDK_PROTOCOL_SOURCE: &str =
    include_str!("../../../../packages/sideral-extension-sdk/src/protocol.ts");
const SDK_RUNTIME_SOURCE: &str =
    include_str!("../../../../packages/sideral-extension-sdk/src/runtime.ts");
const TESTKIT_INDEX_SOURCE: &str =
    include_str!("../../../../packages/sideral-extension-testkit/src/index.ts");

#[derive(Debug, Error)]
enum ToolError {
    #[error("{0}")]
    Usage(String),
    #[error("{context}: {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid extension key: {0}")]
    InvalidKey(String),
    #[error("invalid extension project: {0}")]
    InvalidProject(String),
    #[error("extension package failed: {0}")]
    Package(#[from] sideral_extension_package::PackageError),
    #[error("extension manifest failed: {0}")]
    Manifest(#[from] sideral_extension_core::ManifestError),
    #[error("could not serialize extension metadata: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SigningKeyDocument {
    schema_version: u8,
    algorithm: String,
    private_key: String,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), ToolError> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    match arguments.as_slice() {
        [command, output] if command == "keygen" => keygen(Path::new(output)),
        [command, project, key, output] if command == "pack" => {
            pack(Path::new(project), Path::new(key), Path::new(output))
        }
        [command, package] if command == "inspect" => inspect(Path::new(package)),
        [command, project] if command == "check" => check(Path::new(project)),
        [command, publisher, name, directory] if command == "scaffold" => {
            scaffold(publisher, name, Path::new(directory))
        }
        _ => Err(ToolError::Usage(usage().to_owned())),
    }
}

fn usage() -> &'static str {
    "Usage:\n  sideral-extension-tool keygen <key-file>\n  sideral-extension-tool check <project-directory>\n  sideral-extension-tool pack <project-directory> <key-file> <output.sideralx>\n  sideral-extension-tool inspect <package.sideralx>\n  sideral-extension-tool scaffold <publisher> <name> <directory>"
}

fn keygen(output: &Path) -> Result<(), ToolError> {
    if output.exists() {
        return Err(ToolError::InvalidKey(format!(
            "{} already exists; keys are never overwritten",
            output.display()
        )));
    }
    let mut private_key = [0_u8; 32];
    getrandom::fill(&mut private_key).map_err(|error| {
        ToolError::InvalidKey(format!("could not generate randomness: {error}"))
    })?;
    let document = SigningKeyDocument {
        schema_version: KEY_SCHEMA_VERSION,
        algorithm: "Ed25519".to_owned(),
        private_key: STANDARD.encode(private_key),
    };
    let mut bytes = serde_json::to_vec_pretty(&document)?;
    bytes.push(b'\n');
    write_atomic_new(output, &bytes)?;
    println!(
        "Created {}. Keep this private key outside source control.",
        output.display()
    );
    Ok(())
}

fn pack(project: &Path, key_path: &Path, output: &Path) -> Result<(), ToolError> {
    if output.extension().and_then(|value| value.to_str()) != Some("sideralx") {
        return Err(ToolError::InvalidProject(
            "package output must use the .sideralx suffix".to_owned(),
        ));
    }
    if output.exists() {
        return Err(ToolError::InvalidProject(format!(
            "{} already exists; package outputs are never overwritten",
            output.display()
        )));
    }
    let project = canonical_directory(project)?;
    let manifest_path = project.join(MANIFEST_PATH);
    let manifest_source = read_bounded(&manifest_path, 64 * 1024)?;
    let manifest_text = std::str::from_utf8(&manifest_source).map_err(|error| {
        ToolError::InvalidProject(format!("manifest.json is not UTF-8: {error}"))
    })?;
    let manifest = parse_manifest_json(manifest_text)?;
    ensure_sideral_compatibility(&manifest.id, &manifest.engines.sideral)?;
    let runtime = manifest.runtime.as_ref().ok_or_else(|| {
        ToolError::InvalidProject("manifest must declare a worker runtime".to_owned())
    })?;
    let publisher = manifest.id.split('.').next().ok_or_else(|| {
        ToolError::InvalidProject("manifest extension id has no publisher".to_owned())
    })?;
    let mut files = BTreeMap::from([(MANIFEST_PATH.to_owned(), manifest_source)]);
    insert_project_file(&project, &runtime.entry, &mut files)?;
    collect_assets(&project, &mut files)?;
    let signing_key = read_signing_key(key_path)?;
    let package = build_signed_package(publisher, &signing_key, files)?;
    write_atomic_new(output, &package)?;
    let validated = validate_package_bytes(&package)?;
    println!(
        "Packed {} {} to {} ({} bytes, SHA-256 {}).",
        validated.manifest.id,
        validated.manifest.version,
        output.display(),
        package.len(),
        validated.package_sha256
    );
    Ok(())
}

fn inspect(package: &Path) -> Result<(), ToolError> {
    let bytes = read_bounded(package, 10 * 1024 * 1024)?;
    let validated = validate_package_bytes(&bytes)?;
    let output = serde_json::json!({
        "manifest": validated.manifest,
        "inspection": validated.inspection,
        "publisher": validated.publisher,
        "packageSha256": validated.package_sha256,
        "bundleSha256": validated.bundle_sha256,
    });
    println!("{}", serde_json::to_string_pretty(&output)?);
    Ok(())
}

fn check(project: &Path) -> Result<(), ToolError> {
    let project = canonical_directory(project)?;
    let manifest_source = read_bounded(&project.join(MANIFEST_PATH), 64 * 1024)?;
    let manifest_text = std::str::from_utf8(&manifest_source).map_err(|error| {
        ToolError::InvalidProject(format!("manifest.json is not UTF-8: {error}"))
    })?;
    let manifest = parse_manifest_json(manifest_text)?;
    ensure_sideral_compatibility(&manifest.id, &manifest.engines.sideral)?;
    let runtime = manifest.runtime.as_ref().ok_or_else(|| {
        ToolError::InvalidProject("manifest must declare a worker runtime".to_owned())
    })?;
    let mut files = BTreeMap::from([(MANIFEST_PATH.to_owned(), manifest_source)]);
    insert_project_file(&project, &runtime.entry, &mut files)?;
    collect_assets(&project, &mut files)?;
    let bundle = files
        .get(&runtime.entry)
        .ok_or_else(|| ToolError::InvalidProject("worker bundle was not collected".to_owned()))?;
    let assessment = assess_worker_bundle_size(bundle.len())?;
    println!(
        "Checked {} {}: worker {} bytes, {} packaged project files{}.",
        manifest.id,
        manifest.version,
        assessment.actual_bytes,
        files.len(),
        if assessment.exceeds_recommendation {
            " (worker exceeds the recommended size)"
        } else {
            ""
        }
    );
    Ok(())
}

fn ensure_sideral_compatibility(extension_id: &str, requirement: &str) -> Result<(), ToolError> {
    let tool_version = Version::parse(env!("CARGO_PKG_VERSION")).map_err(|error| {
        ToolError::InvalidProject(format!(
            "extension tool has an invalid Sideral version: {error}"
        ))
    })?;
    let requirement = VersionReq::parse(requirement).map_err(|error| {
        ToolError::InvalidProject(format!(
            "extension {extension_id} has an invalid Sideral engine requirement: {error}"
        ))
    })?;
    if requirement.matches(&tool_version) {
        return Ok(());
    }
    Err(ToolError::InvalidProject(format!(
        "extension {extension_id} requires Sideral {requirement}, but this extension tool targets Sideral {tool_version}"
    )))
}

fn scaffold(publisher: &str, name: &str, directory: &Path) -> Result<(), ToolError> {
    validate_identifier_segment("publisher", publisher)?;
    validate_identifier_segment("name", name)?;
    if directory.exists() {
        return Err(ToolError::InvalidProject(format!(
            "{} already exists; scaffolding never overwrites a directory",
            directory.display()
        )));
    }
    let parent = parent_directory(directory);
    fs::create_dir_all(parent).map_err(|source| ToolError::Io {
        context: format!("could not create {}", parent.display()),
        source,
    })?;
    let temporary = TempDir::new_in(parent).map_err(|source| ToolError::Io {
        context: format!(
            "could not create a temporary project in {}",
            parent.display()
        ),
        source,
    })?;
    let project = temporary.path();
    create_directory(&project.join("src"), "extension source directory")?;
    create_directory(
        &project.join("vendor/sideral-extension-sdk/src"),
        "embedded extension SDK directory",
    )?;
    create_directory(
        &project.join("vendor/sideral-extension-testkit/src"),
        "embedded extension testkit directory",
    )?;
    let extension_id = format!("{publisher}.{name}");
    let command_id = format!("{extension_id}.hello");
    write_new_file(
        &project.join("manifest.json"),
        scaffold_manifest(&extension_id, &command_id).as_bytes(),
    )?;
    write_new_file(
        &project.join("package.json"),
        scaffold_package_json(&extension_id).as_bytes(),
    )?;
    write_new_file(&project.join("tsconfig.json"), SCAFFOLD_TSCONFIG.as_bytes())?;
    write_new_file(
        &project.join("src").join("extension.ts"),
        scaffold_source(&command_id).as_bytes(),
    )?;
    write_new_file(
        &project.join("src").join("extension.test.ts"),
        scaffold_test(&extension_id, &command_id).as_bytes(),
    )?;
    write_new_file(
        &project.join("README.md"),
        scaffold_readme(&extension_id).as_bytes(),
    )?;
    write_embedded_devkit(project)?;
    write_new_file(
        &project.join(".gitignore"),
        b"dist/\n*.sideralx\n.sideral/\n",
    )?;
    let staging = temporary.keep();
    if let Err(source) = fs::rename(&staging, directory) {
        let _ = fs::remove_dir_all(&staging);
        return Err(ToolError::Io {
            context: format!("could not publish scaffold at {}", directory.display()),
            source,
        });
    }
    println!(
        "Created extension project {} in {}.",
        extension_id,
        directory.display()
    );
    Ok(())
}

fn create_directory(path: &Path, description: &str) -> Result<(), ToolError> {
    fs::create_dir_all(path).map_err(|source| ToolError::Io {
        context: format!("could not create {description}"),
        source,
    })
}

fn write_embedded_devkit(project: &Path) -> Result<(), ToolError> {
    let sdk = project.join("vendor/sideral-extension-sdk");
    write_new_file(&sdk.join("package.json"), EMBEDDED_SDK_PACKAGE.as_bytes())?;
    for (name, source) in [
        ("index.ts", SDK_INDEX_SOURCE),
        ("manifest.ts", SDK_MANIFEST_SOURCE),
        ("protocol.ts", SDK_PROTOCOL_SOURCE),
        ("runtime.ts", SDK_RUNTIME_SOURCE),
    ] {
        write_new_file(&sdk.join("src").join(name), source.as_bytes())?;
    }

    let testkit = project.join("vendor/sideral-extension-testkit");
    write_new_file(
        &testkit.join("package.json"),
        EMBEDDED_TESTKIT_PACKAGE.as_bytes(),
    )?;
    write_new_file(
        &testkit.join("src/index.ts"),
        TESTKIT_INDEX_SOURCE.as_bytes(),
    )
}

fn read_signing_key(path: &Path) -> Result<SigningKey, ToolError> {
    let bytes = read_bounded(path, MAX_KEY_FILE_BYTES)?;
    let document: SigningKeyDocument =
        serde_json::from_slice(&bytes).map_err(|error| ToolError::InvalidKey(error.to_string()))?;
    if document.schema_version != KEY_SCHEMA_VERSION || document.algorithm != "Ed25519" {
        return Err(ToolError::InvalidKey(
            "unsupported key schema or algorithm".to_owned(),
        ));
    }
    let bytes = STANDARD
        .decode(document.private_key)
        .map_err(|error| ToolError::InvalidKey(format!("private key is not Base64: {error}")))?;
    let bytes: [u8; 32] = bytes.try_into().map_err(|_| {
        ToolError::InvalidKey("private key must contain exactly 32 bytes".to_owned())
    })?;
    Ok(SigningKey::from_bytes(&bytes))
}

fn insert_project_file(
    project: &Path,
    relative_path: &str,
    files: &mut BTreeMap<String, Vec<u8>>,
) -> Result<(), ToolError> {
    validate_package_path("project file", relative_path)?;
    let path = project.join(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    let canonical = fs::canonicalize(&path).map_err(|source| ToolError::Io {
        context: format!("could not resolve {}", path.display()),
        source,
    })?;
    if !canonical.starts_with(project) || !canonical.is_file() {
        return Err(ToolError::InvalidProject(format!(
            "{} is outside the project or is not a file",
            canonical.display()
        )));
    }
    let content = read_bounded(&canonical, 10 * 1024 * 1024)?;
    if files.insert(relative_path.to_owned(), content).is_some() {
        return Err(ToolError::InvalidProject(format!(
            "duplicate project file {relative_path}"
        )));
    }
    Ok(())
}

fn collect_assets(project: &Path, files: &mut BTreeMap<String, Vec<u8>>) -> Result<(), ToolError> {
    let assets = project.join("assets");
    if !assets.exists() {
        return Ok(());
    }
    if !assets.is_dir() {
        return Err(ToolError::InvalidProject(
            "assets must be a directory".to_owned(),
        ));
    }
    let mut queue = VecDeque::from([assets]);
    while let Some(directory) = queue.pop_front() {
        for entry in fs::read_dir(&directory).map_err(|source| ToolError::Io {
            context: format!("could not read {}", directory.display()),
            source,
        })? {
            let entry = entry.map_err(|source| ToolError::Io {
                context: format!("could not read an entry in {}", directory.display()),
                source,
            })?;
            let file_type = entry.file_type().map_err(|source| ToolError::Io {
                context: format!("could not inspect {}", entry.path().display()),
                source,
            })?;
            if file_type.is_symlink() {
                return Err(ToolError::InvalidProject(format!(
                    "asset {} cannot be a symbolic link",
                    entry.path().display()
                )));
            }
            if file_type.is_dir() {
                queue.push_back(entry.path());
                continue;
            }
            if !file_type.is_file() {
                return Err(ToolError::InvalidProject(format!(
                    "asset {} is not a regular file",
                    entry.path().display()
                )));
            }
            let path = entry.path();
            let relative = path.strip_prefix(project).map_err(|_| {
                ToolError::InvalidProject("asset traversal escaped the project".to_owned())
            })?;
            let relative = relative.to_string_lossy().replace('\\', "/");
            insert_project_file(project, &relative, files)?;
            if files.len() > MAX_PROJECT_FILES {
                return Err(ToolError::InvalidProject(format!(
                    "project exceeds {MAX_PROJECT_FILES} package files"
                )));
            }
        }
    }
    Ok(())
}

fn canonical_directory(path: &Path) -> Result<PathBuf, ToolError> {
    let canonical = fs::canonicalize(path).map_err(|source| ToolError::Io {
        context: format!("could not resolve {}", path.display()),
        source,
    })?;
    if !canonical.is_dir() {
        return Err(ToolError::InvalidProject(format!(
            "{} is not a directory",
            canonical.display()
        )));
    }
    Ok(canonical)
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, ToolError> {
    let file = fs::File::open(path).map_err(|source| ToolError::Io {
        context: format!("could not open {}", path.display()),
        source,
    })?;
    let metadata = file.metadata().map_err(|source| ToolError::Io {
        context: format!("could not inspect {}", path.display()),
        source,
    })?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(ToolError::InvalidProject(format!(
            "{} is not a regular file within the {limit}-byte limit",
            path.display()
        )));
    }
    let mut bytes = Vec::with_capacity(
        usize::try_from(metadata.len())
            .unwrap_or(64 * 1024)
            .min(64 * 1024),
    );
    file.take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|source| ToolError::Io {
            context: format!("could not read {}", path.display()),
            source,
        })?;
    if bytes.len() as u64 > limit {
        return Err(ToolError::InvalidProject(format!(
            "{} exceeds its {limit}-byte limit",
            path.display()
        )));
    }
    Ok(bytes)
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), ToolError> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).map_err(|source| ToolError::Io {
            context: format!("could not create {}", parent.display()),
            source,
        })?;
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|source| ToolError::Io {
            context: format!("could not create {}", path.display()),
            source,
        })?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|source| ToolError::Io {
            context: format!("could not persist {}", path.display()),
            source,
        })
}

fn write_atomic_new(path: &Path, bytes: &[u8]) -> Result<(), ToolError> {
    let parent = parent_directory(path);
    fs::create_dir_all(parent).map_err(|source| ToolError::Io {
        context: format!("could not create {}", parent.display()),
        source,
    })?;
    let mut temporary = NamedTempFile::new_in(parent).map_err(|source| ToolError::Io {
        context: format!(
            "could not create a temporary package in {}",
            parent.display()
        ),
        source,
    })?;
    temporary
        .write_all(bytes)
        .and_then(|()| temporary.as_file_mut().sync_all())
        .map_err(|source| ToolError::Io {
            context: "could not persist temporary package".to_owned(),
            source,
        })?;
    temporary
        .persist_noclobber(path)
        .map_err(|error| ToolError::Io {
            context: format!("could not create {}", path.display()),
            source: error.error,
        })?;
    Ok(())
}

fn parent_directory(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

fn validate_identifier_segment(kind: &str, value: &str) -> Result<(), ToolError> {
    if value.is_empty()
        || value.len() > 64
        || value.starts_with('-')
        || value.ends_with('-')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err(ToolError::Usage(format!(
            "{kind} must use lowercase ASCII letters, digits or inner hyphens"
        )));
    }
    Ok(())
}

fn scaffold_manifest(extension_id: &str, command_id: &str) -> String {
    format!(
        r#"{{
  "manifestVersion": 1,
  "apiVersion": 1,
  "id": "{extension_id}",
  "displayName": "My Sideral Extension",
  "version": "0.1.0",
  "engines": {{ "sideral": "^0.1.0" }},
  "runtime": {{ "kind": "worker", "entry": "dist/extension.mjs" }},
  "contributes": {{
    "commands": [{{ "id": "{command_id}", "title": "Say hello" }}]
  }}
}}
"#
    )
}

fn scaffold_package_json(extension_id: &str) -> String {
    format!(
        r#"{{
  "name": "{extension_id}",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {{
    "build": "rolldown src/extension.ts --file dist/extension.mjs --format esm --platform browser --minify",
    "check": "npm run typecheck && npm test && npm run build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }},
  "devDependencies": {{
    "@sideral/extension-sdk": "file:vendor/sideral-extension-sdk",
    "@sideral/extension-testkit": "file:vendor/sideral-extension-testkit",
    "rolldown": "1.2.3",
    "typescript": "7.0.2",
    "vitest": "4.1.10"
  }}
}}
"#
    )
}

fn scaffold_test(extension_id: &str, command_id: &str) -> String {
    format!(
        r#"import type {{ ExtensionModule }} from "@sideral/extension-sdk";
import {{ createExtensionHarness }} from "@sideral/extension-testkit";
import {{ describe, expect, it }} from "vitest";
import {{ activate }} from "./extension";

const extensionModule: ExtensionModule = {{ activate }};

describe("{extension_id}", () => {{
  it("registers and executes its declared command", async () => {{
    const harness = createExtensionHarness(extensionModule, {{
      extensionId: "{extension_id}",
    }});

    await harness.activate();
    await expect(harness.executeCommand("{command_id}")).resolves.toEqual({{ ok: true }});
    expect(harness.messages).toEqual([
      {{ severity: "information", message: "Hello from a Sideral extension." }},
    ]);
    await harness.dispose();
  }});
}});
"#
    )
}

fn scaffold_readme(extension_id: &str) -> String {
    format!(
        r#"# {extension_id}

This is a standalone Sideral extension generated with the official tool.

```powershell
npm install
npm run check
```

The exact type-only SDK and deterministic testkit used by this scaffold are
pinned under `vendor/`, so development does not depend on the Sideral source
tree or an unpublished registry package. Only `manifest.json`, the built Worker
and optional `assets/` enter the signed `.sideralx` package.
"#
    )
}

fn scaffold_source(command_id: &str) -> String {
    format!(
        r#"import type {{ ExtensionModule }} from "@sideral/extension-sdk";

export const activate: ExtensionModule["activate"] = (context, api) => {{
  context.subscriptions.add(
    api.commands.registerCommand("{command_id}", async () => {{
      await api.window.showInformationMessage("Hello from a Sideral extension.");
      return {{ ok: true }};
    }}),
  );
}};
"#
    )
}

const SCAFFOLD_TSCONFIG: &str = r#"{
  "compilerOptions": {
    "target": "ES2024",
    "lib": ["ES2024", "WebWorker"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src"]
}
"#;

const EMBEDDED_SDK_PACKAGE: &str = r#"{
  "name": "@sideral/extension-sdk",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "types": "./src/index.ts",
  "exports": {
    ".": { "types": "./src/index.ts" },
    "./protocol": { "types": "./src/protocol.ts" }
  }
}
"#;

const EMBEDDED_TESTKIT_PACKAGE: &str = r#"{
  "name": "@sideral/extension-testkit",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts"
    }
  },
  "peerDependencies": {
    "@sideral/extension-sdk": "0.1.0"
  }
}
"#;

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::Value;
    use tempfile::tempdir;

    use super::{ToolError, check, ensure_sideral_compatibility, scaffold};

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[test]
    fn scaffold_is_standalone_and_passes_project_validation_after_build() -> TestResult {
        let directory = tempdir()?;
        let project = directory.path().join("acme-sample");

        scaffold("acme", "sample", &project)?;

        let package: Value = serde_json::from_slice(&fs::read(project.join("package.json"))?)?;
        assert_eq!(
            package["devDependencies"]["@sideral/extension-sdk"],
            "file:vendor/sideral-extension-sdk"
        );
        assert_eq!(
            package["devDependencies"]["@sideral/extension-testkit"],
            "file:vendor/sideral-extension-testkit"
        );
        let embedded_sdk =
            fs::read_to_string(project.join("vendor/sideral-extension-sdk/src/runtime.ts"))?;
        assert!(embedded_sdk.contains("export interface ProcessRequest"));
        assert!(project.join("src/extension.test.ts").is_file());

        fs::create_dir(project.join("dist"))?;
        fs::write(
            project.join("dist/extension.mjs"),
            b"export const activate=()=>{};\n",
        )?;
        check(&project)?;
        Ok(())
    }

    #[test]
    fn compatibility_validation_rejects_an_engine_for_an_unavailable_version() {
        assert!(matches!(
            ensure_sideral_compatibility("acme.sample", "<0.0.0"),
            Err(ToolError::InvalidProject(message))
                if message.contains("requires Sideral <0.0.0")
                    && message.contains(concat!(
                        "targets Sideral ",
                        env!("CARGO_PKG_VERSION")
                    ))
        ));
    }
}
