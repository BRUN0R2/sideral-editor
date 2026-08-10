use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use sideral_extension_core::{
    ExtensionManifest, extension_size_budget, normalize_keybinding, validate_package_path,
    validate_package_size,
};
use sideral_extension_package::{
    PublisherIdentity, ValidatedExtensionPackage, validate_package_bytes,
};
use tempfile::NamedTempFile;

use super::{
    error::ExtensionError,
    protocol::{
        ExtensionCommandView, ExtensionKeybindingView, ExtensionRuntimeState, ExtensionSnapshot,
        InstalledExtensionView, KeybindingUpdate, PackageInstallView, RuntimeDiagnostic,
    },
};

const REGISTRY_SCHEMA_VERSION: u8 = 1;
const TRUST_SCHEMA_VERSION: u8 = 1;
const REGISTRY_FILE_NAME: &str = "registry.json";
const TRUST_FILE_NAME: &str = "trusted-publishers.json";
const PACKAGES_DIRECTORY_NAME: &str = "packages";
const REGISTRY_FILE_LIMIT_BYTES: u64 = 2 * 1024 * 1024;
const TRUST_FILE_LIMIT_BYTES: u64 = 256 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistryDocument {
    schema_version: u8,
    revision: u64,
    extensions: BTreeMap<String, InstalledExtension>,
    #[serde(default)]
    keybinding_overrides: BTreeMap<String, Option<String>>,
}

impl Default for RegistryDocument {
    fn default() -> Self {
        Self {
            schema_version: REGISTRY_SCHEMA_VERSION,
            revision: 0,
            extensions: BTreeMap::new(),
            keybinding_overrides: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InstalledExtension {
    pub enabled: bool,
    pub active: PackageSlot,
    pub rollback: Option<PackageSlot>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PackageSlot {
    pub manifest: ExtensionManifest,
    pub package_file: String,
    pub package_sha256: String,
    pub bundle_sha256: String,
    pub publisher: PublisherIdentity,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustDocument {
    schema_version: u8,
    publishers: BTreeMap<String, TrustedPublisher>,
}

impl Default for TrustDocument {
    fn default() -> Self {
        Self {
            schema_version: TRUST_SCHEMA_VERSION,
            publishers: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustedPublisher {
    publisher: String,
    public_key: String,
}

pub(crate) struct ExtensionRegistry {
    root: PathBuf,
    registry_path: PathBuf,
    trust_path: PathBuf,
    app_version: Version,
    document: RegistryDocument,
    trust: TrustDocument,
}

impl ExtensionRegistry {
    pub fn load(root: PathBuf, app_version: Version) -> Result<Self, ExtensionError> {
        let registry_path = root.join(REGISTRY_FILE_NAME);
        let trust_path = root.join(TRUST_FILE_NAME);
        let document =
            read_json_document::<RegistryDocument>(&registry_path, REGISTRY_FILE_LIMIT_BYTES)?
                .unwrap_or_default();
        let trust = read_json_document::<TrustDocument>(&trust_path, TRUST_FILE_LIMIT_BYTES)?
            .unwrap_or_default();
        validate_registry_document(&document)?;
        validate_trust_document(&trust)?;

        Ok(Self {
            root,
            registry_path,
            trust_path,
            app_version,
            document,
            trust,
        })
    }

    pub fn inspect_package(
        &self,
        path: &Path,
    ) -> Result<ValidatedExtensionPackage, ExtensionError> {
        let bytes = read_package(path)?;
        let package = validate_package_bytes(&bytes)?;
        self.ensure_compatible(&package.manifest)?;
        Ok(package)
    }

    pub fn package_install_view(&self, package: &ValidatedExtensionPackage) -> PackageInstallView {
        PackageInstallView {
            id: package.manifest.id.clone(),
            display_name: package.manifest.display_name.clone(),
            version: package.manifest.version.clone(),
            description: package.manifest.description.clone(),
            publisher: package.publisher.publisher.clone(),
            key_id: package.publisher.key_id.clone(),
            public_key: package.publisher.public_key.clone(),
            package_sha256: package.package_sha256.clone(),
            bundle_sha256: package.bundle_sha256.clone(),
            permissions: package.manifest.permissions.clone(),
            activation_events: package.manifest.activation_events.clone(),
            commands: package.manifest.contributes.commands.clone(),
            keybindings: package.manifest.contributes.keybindings.clone(),
            replaces_version: self
                .document
                .extensions
                .get(&package.manifest.id)
                .map(|installed| installed.active.manifest.version.clone()),
        }
    }

    pub fn preflight_install(
        &self,
        source_path: &Path,
        expected_package_sha256: &str,
        approve_publisher: bool,
    ) -> Result<(String, bool), ExtensionError> {
        let package = self.inspect_package(source_path)?;
        self.ensure_command_ids_available(&package.manifest)?;
        if package.package_sha256 != expected_package_sha256 {
            return Err(ExtensionError::Conflict(
                "package changed after it was inspected".to_owned(),
            ));
        }
        if !self.publisher_is_trusted(&package.publisher) && !approve_publisher {
            return Err(ExtensionError::PermissionDenied(format!(
                "publisher key {} has not been trusted",
                package.publisher.key_id
            )));
        }
        let already_installed = self
            .document
            .extensions
            .get(&package.manifest.id)
            .is_some_and(|installed| installed.active.package_sha256 == package.package_sha256);
        Ok((package.manifest.id, already_installed))
    }

    pub fn publisher_is_trusted(&self, publisher: &PublisherIdentity) -> bool {
        self.trust
            .publishers
            .get(&publisher.key_id)
            .is_some_and(|trusted| {
                trusted.publisher == publisher.publisher
                    && trusted.public_key == publisher.public_key
            })
    }

    pub fn install_package(
        &mut self,
        source_path: &Path,
        expected_package_sha256: &str,
        approve_publisher: bool,
    ) -> Result<String, ExtensionError> {
        let bytes = read_package(source_path)?;
        let package = validate_package_bytes(&bytes)?;
        self.ensure_compatible(&package.manifest)?;
        self.ensure_command_ids_available(&package.manifest)?;
        if package.package_sha256 != expected_package_sha256 {
            return Err(ExtensionError::Conflict(
                "package changed after it was inspected".to_owned(),
            ));
        }
        if !self.publisher_is_trusted(&package.publisher) {
            if !approve_publisher {
                return Err(ExtensionError::PermissionDenied(format!(
                    "publisher key {} has not been trusted",
                    package.publisher.key_id
                )));
            }
            let mut next_trust = self.trust.clone();
            next_trust.publishers.insert(
                package.publisher.key_id.clone(),
                TrustedPublisher {
                    publisher: package.publisher.publisher.clone(),
                    public_key: package.publisher.public_key.clone(),
                },
            );
            write_json_document(&self.trust_path, &next_trust, TRUST_FILE_LIMIT_BYTES)?;
            self.trust = next_trust;
        }

        if self
            .document
            .extensions
            .get(&package.manifest.id)
            .is_some_and(|installed| installed.active.package_sha256 == package.package_sha256)
        {
            return Ok(package.manifest.id);
        }

        let relative_package_path = package_relative_path(&package);
        let destination = self.root.join(&relative_package_path);
        persist_package(&destination, &bytes, &package.package_sha256)?;

        let slot = PackageSlot {
            manifest: package.manifest.clone(),
            package_file: relative_package_path,
            package_sha256: package.package_sha256.clone(),
            bundle_sha256: package.bundle_sha256.clone(),
            publisher: package.publisher.clone(),
        };
        let mut next_document = self.document.clone();
        next_document.extensions.insert(
            package.manifest.id.clone(),
            InstalledExtension {
                enabled: true,
                active: slot,
                rollback: self
                    .document
                    .extensions
                    .get(&package.manifest.id)
                    .map(|installed| installed.active.clone()),
            },
        );
        prune_keybinding_overrides(&mut next_document);
        next_document.revision = next_document.revision.saturating_add(1);
        write_json_document(
            &self.registry_path,
            &next_document,
            REGISTRY_FILE_LIMIT_BYTES,
        )?;
        self.document = next_document;
        Ok(package.manifest.id)
    }

    pub fn set_enabled(&mut self, extension_id: &str, enabled: bool) -> Result<(), ExtensionError> {
        if enabled {
            let installed = self
                .document
                .extensions
                .get(extension_id)
                .ok_or_else(|| ExtensionError::NotFound(extension_id.to_owned()))?;
            self.validate_installed_slot(&installed.active)?;
        }
        let mut next_document = self.document.clone();
        let extension = next_document
            .extensions
            .get_mut(extension_id)
            .ok_or_else(|| ExtensionError::NotFound(extension_id.to_owned()))?;
        if extension.enabled == enabled {
            return Ok(());
        }
        extension.enabled = enabled;
        next_document.revision = next_document.revision.saturating_add(1);
        write_json_document(
            &self.registry_path,
            &next_document,
            REGISTRY_FILE_LIMIT_BYTES,
        )?;
        self.document = next_document;
        Ok(())
    }

    pub fn rollback(&mut self, extension_id: &str) -> Result<(), ExtensionError> {
        let rollback = self
            .document
            .extensions
            .get(extension_id)
            .ok_or_else(|| ExtensionError::NotFound(extension_id.to_owned()))?
            .rollback
            .clone()
            .ok_or_else(|| {
                ExtensionError::Conflict(format!(
                    "extension {extension_id} has no rollback version"
                ))
            })?;
        self.validate_installed_slot(&rollback)?;
        let mut next_document = self.document.clone();
        let installed = next_document
            .extensions
            .get_mut(extension_id)
            .ok_or_else(|| ExtensionError::NotFound(extension_id.to_owned()))?;
        let rollback = installed.rollback.take().ok_or_else(|| {
            ExtensionError::Conflict(format!("extension {extension_id} has no rollback version"))
        })?;
        let previous_active = std::mem::replace(&mut installed.active, rollback);
        installed.rollback = Some(previous_active);
        prune_keybinding_overrides(&mut next_document);
        next_document.revision = next_document.revision.saturating_add(1);
        write_json_document(
            &self.registry_path,
            &next_document,
            REGISTRY_FILE_LIMIT_BYTES,
        )?;
        self.document = next_document;
        Ok(())
    }

    pub fn validate_rollback(&self, extension_id: &str) -> Result<(), ExtensionError> {
        let rollback = self
            .document
            .extensions
            .get(extension_id)
            .ok_or_else(|| ExtensionError::NotFound(extension_id.to_owned()))?
            .rollback
            .as_ref()
            .ok_or_else(|| {
                ExtensionError::Conflict(format!(
                    "extension {extension_id} has no rollback version"
                ))
            })?;
        self.validate_installed_slot(rollback).map(|_| ())
    }

    pub fn uninstall(&mut self, extension_id: &str) -> Result<Vec<PathBuf>, ExtensionError> {
        let mut next_document = self.document.clone();
        let installed = next_document
            .extensions
            .remove(extension_id)
            .ok_or_else(|| ExtensionError::NotFound(extension_id.to_owned()))?;
        prune_keybinding_overrides(&mut next_document);
        next_document.revision = next_document.revision.saturating_add(1);
        write_json_document(
            &self.registry_path,
            &next_document,
            REGISTRY_FILE_LIMIT_BYTES,
        )?;
        self.document = next_document;

        let mut paths = vec![self.root.join(installed.active.package_file)];
        if let Some(rollback) = installed.rollback {
            paths.push(self.root.join(rollback.package_file));
        }
        Ok(paths)
    }

    pub fn active(&self, extension_id: &str) -> Result<&InstalledExtension, ExtensionError> {
        let installed = self
            .document
            .extensions
            .get(extension_id)
            .ok_or_else(|| ExtensionError::NotFound(extension_id.to_owned()))?;
        if !installed.enabled {
            return Err(ExtensionError::Disabled(extension_id.to_owned()));
        }
        self.ensure_compatible(&installed.active.manifest)?;
        Ok(installed)
    }

    pub fn update_keybinding(
        &mut self,
        command_id: &str,
        update: KeybindingUpdate,
    ) -> Result<(), ExtensionError> {
        let binding_exists = self.document.extensions.values().any(|installed| {
            installed
                .active
                .manifest
                .contributes
                .keybindings
                .iter()
                .any(|binding| binding.command == command_id)
        });
        if !binding_exists {
            return Err(ExtensionError::NotFound(command_id.to_owned()));
        }

        let mut next_document = self.document.clone();
        match update {
            KeybindingUpdate::Default => {
                next_document.keybinding_overrides.remove(command_id);
            }
            KeybindingUpdate::Disabled => {
                next_document
                    .keybinding_overrides
                    .insert(command_id.to_owned(), None);
            }
            KeybindingUpdate::Custom { key } => {
                let normalized = normalize_keybinding(&key)
                    .map_err(|error| ExtensionError::InvalidRequest(error.to_string()))?;
                next_document
                    .keybinding_overrides
                    .insert(command_id.to_owned(), Some(normalized));
            }
        }
        if next_document.keybinding_overrides == self.document.keybinding_overrides {
            return Ok(());
        }
        next_document.revision = next_document.revision.saturating_add(1);
        write_json_document(
            &self.registry_path,
            &next_document,
            REGISTRY_FILE_LIMIT_BYTES,
        )?;
        self.document = next_document;
        Ok(())
    }

    pub fn extension_for_command(
        &self,
        command_id: &str,
    ) -> Result<&InstalledExtension, ExtensionError> {
        self.document
            .extensions
            .values()
            .find(|installed| {
                installed.enabled
                    && installed
                        .active
                        .manifest
                        .contributes
                        .commands
                        .iter()
                        .any(|command| command.id == command_id)
            })
            .ok_or_else(|| ExtensionError::NotFound(command_id.to_owned()))
    }

    pub fn extensions_for_activation(&self, event: &str) -> Vec<String> {
        self.document
            .extensions
            .iter()
            .filter(|(_, installed)| {
                installed.enabled
                    && installed
                        .active
                        .manifest
                        .activation_events
                        .iter()
                        .any(|activation| activation == event)
            })
            .map(|(extension_id, _)| extension_id.clone())
            .collect()
    }

    pub fn load_bundle(&self, extension_id: &str) -> Result<Vec<u8>, ExtensionError> {
        let installed = self.active(extension_id)?;
        let package = self.validate_installed_slot(&installed.active)?;
        Ok(package.bundle)
    }

    pub fn snapshot(&self, runtimes: &BTreeMap<String, RuntimeDiagnostic>) -> ExtensionSnapshot {
        let mut extensions = Vec::with_capacity(self.document.extensions.len());
        let mut commands = Vec::new();
        let mut keybindings_by_extension = BTreeMap::new();
        for (extension_id, installed) in &self.document.extensions {
            let command_titles = installed
                .active
                .manifest
                .contributes
                .commands
                .iter()
                .map(|command| (command.id.as_str(), command.title.as_str()))
                .collect::<BTreeMap<_, _>>();
            let views = installed
                .active
                .manifest
                .contributes
                .keybindings
                .iter()
                .map(|binding| {
                    let default_key = platform_default_key(binding);
                    let user_defined = self
                        .document
                        .keybinding_overrides
                        .contains_key(&binding.command);
                    let key = self
                        .document
                        .keybinding_overrides
                        .get(&binding.command)
                        .cloned()
                        .unwrap_or_else(|| Some(default_key.clone()));
                    ExtensionKeybindingView {
                        extension_id: extension_id.clone(),
                        command_id: binding.command.clone(),
                        command_title: command_titles
                            .get(binding.command.as_str())
                            .copied()
                            .unwrap_or(binding.command.as_str())
                            .to_owned(),
                        default_key,
                        key,
                        languages: binding.languages.clone(),
                        user_defined,
                        conflict: false,
                    }
                })
                .collect::<Vec<_>>();
            keybindings_by_extension.insert(extension_id.clone(), views);
        }

        let enabled_bindings = keybindings_by_extension
            .iter()
            .filter(|(extension_id, _)| {
                self.document
                    .extensions
                    .get(*extension_id)
                    .is_some_and(|installed| installed.enabled)
            })
            .flat_map(|(_, bindings)| bindings.iter())
            .collect::<Vec<_>>();
        let mut conflicts = HashSet::new();
        for (index, left) in enabled_bindings.iter().enumerate() {
            let Some(left_key) = left.key.as_deref() else {
                continue;
            };
            for right in enabled_bindings.iter().skip(index + 1) {
                if right.key.as_deref() == Some(left_key)
                    && languages_overlap(&left.languages, &right.languages)
                {
                    conflicts.insert(left.command_id.clone());
                    conflicts.insert(right.command_id.clone());
                }
            }
        }
        for bindings in keybindings_by_extension.values_mut() {
            for binding in bindings {
                binding.conflict = conflicts.contains(&binding.command_id);
            }
        }
        let mut keybindings = Vec::new();
        for (extension_id, installed) in &self.document.extensions {
            let extension_commands = installed
                .active
                .manifest
                .contributes
                .commands
                .iter()
                .map(|command| ExtensionCommandView::from_contribution(extension_id, command))
                .collect::<Vec<_>>();
            if installed.enabled {
                commands.extend(extension_commands.iter().cloned());
                keybindings.extend(
                    keybindings_by_extension
                        .get(extension_id)
                        .into_iter()
                        .flatten()
                        .cloned(),
                );
            }
            extensions.push(InstalledExtensionView {
                id: extension_id.clone(),
                display_name: installed.active.manifest.display_name.clone(),
                version: installed.active.manifest.version.clone(),
                description: installed.active.manifest.description.clone(),
                enabled: installed.enabled,
                development: false,
                publisher: installed.active.publisher.publisher.clone(),
                permissions: installed.active.manifest.permissions.clone(),
                activation_events: installed.active.manifest.activation_events.clone(),
                commands: extension_commands,
                keybindings: keybindings_by_extension
                    .get(extension_id)
                    .cloned()
                    .unwrap_or_default(),
                runtime: runtimes
                    .get(extension_id)
                    .cloned()
                    .unwrap_or_else(|| RuntimeDiagnostic {
                        state: ExtensionRuntimeState::Dormant,
                        ..RuntimeDiagnostic::default()
                    }),
                rollback_version: installed
                    .rollback
                    .as_ref()
                    .map(|slot| slot.manifest.version.clone()),
            });
        }
        ExtensionSnapshot {
            sequence: 0,
            revision: self.document.revision,
            extensions,
            commands,
            keybindings,
        }
    }

    fn ensure_compatible(&self, manifest: &ExtensionManifest) -> Result<(), ExtensionError> {
        let requirement = VersionReq::parse(&manifest.engines.sideral).map_err(|error| {
            ExtensionError::InvalidPackage(format!("invalid engine requirement: {error}"))
        })?;
        if !requirement.matches(&self.app_version) {
            return Err(ExtensionError::Incompatible {
                extension_id: manifest.id.clone(),
                requirement: manifest.engines.sideral.clone(),
            });
        }
        Ok(())
    }

    fn ensure_command_ids_available(
        &self,
        manifest: &ExtensionManifest,
    ) -> Result<(), ExtensionError> {
        for command in &manifest.contributes.commands {
            if let Some(owner) =
                self.document
                    .extensions
                    .iter()
                    .find_map(|(extension_id, installed)| {
                        (extension_id != &manifest.id
                            && installed
                                .active
                                .manifest
                                .contributes
                                .commands
                                .iter()
                                .any(|existing| existing.id == command.id))
                        .then_some(extension_id)
                    })
            {
                return Err(ExtensionError::Conflict(format!(
                    "command {} is already contributed by {owner}",
                    command.id
                )));
            }
        }
        Ok(())
    }

    fn validate_installed_slot(
        &self,
        slot: &PackageSlot,
    ) -> Result<ValidatedExtensionPackage, ExtensionError> {
        self.ensure_compatible(&slot.manifest)?;
        let path = self.root.join(&slot.package_file);
        let bytes = read_package(&path)?;
        let package = validate_package_bytes(&bytes)?;
        if package.manifest != slot.manifest
            || package.package_sha256 != slot.package_sha256
            || package.bundle_sha256 != slot.bundle_sha256
            || package.publisher != slot.publisher
            || !self.publisher_is_trusted(&package.publisher)
        {
            return Err(ExtensionError::InvalidPackage(format!(
                "installed package for {} no longer matches its registry record",
                slot.manifest.id
            )));
        }
        Ok(package)
    }
}

fn validate_registry_document(document: &RegistryDocument) -> Result<(), ExtensionError> {
    if document.schema_version != REGISTRY_SCHEMA_VERSION {
        return Err(ExtensionError::InvalidRegistry(format!(
            "registry schema version {} is unsupported",
            document.schema_version
        )));
    }
    let mut command_owners = BTreeMap::new();
    for (id, installed) in &document.extensions {
        validate_slot(id, &installed.active)?;
        if let Some(rollback) = &installed.rollback {
            validate_slot(id, rollback)?;
        }
        for command in &installed.active.manifest.contributes.commands {
            if let Some(previous_owner) = command_owners.insert(command.id.as_str(), id.as_str()) {
                return Err(ExtensionError::InvalidRegistry(format!(
                    "command {} is contributed by both {previous_owner} and {id}",
                    command.id
                )));
            }
        }
    }
    for (command_id, key) in &document.keybinding_overrides {
        let exists = document.extensions.values().any(|installed| {
            installed
                .active
                .manifest
                .contributes
                .keybindings
                .iter()
                .any(|binding| binding.command == *command_id)
        });
        if !exists {
            return Err(ExtensionError::InvalidRegistry(format!(
                "keybinding override references unknown command {command_id}"
            )));
        }
        if let Some(key) = key {
            let normalized = normalize_keybinding(key)
                .map_err(|error| ExtensionError::InvalidRegistry(error.to_string()))?;
            if normalized != *key {
                return Err(ExtensionError::InvalidRegistry(format!(
                    "keybinding override for {command_id} is not canonical"
                )));
            }
        }
    }
    Ok(())
}

fn platform_default_key(binding: &sideral_extension_core::KeybindingContribution) -> String {
    if cfg!(target_os = "macos") {
        binding.mac.clone().unwrap_or_else(|| binding.key.clone())
    } else {
        binding.key.clone()
    }
}

fn languages_overlap(left: &[String], right: &[String]) -> bool {
    left.is_empty()
        || right.is_empty()
        || left
            .iter()
            .any(|language| right.iter().any(|candidate| candidate == language))
}

fn prune_keybinding_overrides(document: &mut RegistryDocument) {
    let commands = document
        .extensions
        .values()
        .flat_map(|installed| &installed.active.manifest.contributes.keybindings)
        .map(|binding| binding.command.clone())
        .collect::<HashSet<_>>();
    document
        .keybinding_overrides
        .retain(|command_id, _| commands.contains(command_id));
}

fn validate_slot(id: &str, slot: &PackageSlot) -> Result<(), ExtensionError> {
    slot.manifest
        .validate()
        .map_err(|error| ExtensionError::InvalidRegistry(error.to_string()))?;
    if slot.manifest.id != id {
        return Err(ExtensionError::InvalidRegistry(format!(
            "registry key {id} does not match manifest id {}",
            slot.manifest.id
        )));
    }
    validate_package_path("registry package path", &slot.package_file)
        .map_err(|error| ExtensionError::InvalidRegistry(error.to_string()))?;
    let expected_prefix = format!("{PACKAGES_DIRECTORY_NAME}/{id}/");
    let package_name = slot
        .package_file
        .strip_prefix(&expected_prefix)
        .ok_or_else(|| {
            ExtensionError::InvalidRegistry(format!(
                "package path for {id} must be inside {expected_prefix}"
            ))
        })?;
    if package_name.is_empty() || package_name.contains('/') || !package_name.ends_with(".sideralx")
    {
        return Err(ExtensionError::InvalidRegistry(format!(
            "package path for {id} must identify one .sideralx file"
        )));
    }
    if !is_sha256(&slot.package_sha256) || !is_sha256(&slot.bundle_sha256) {
        return Err(ExtensionError::InvalidRegistry(format!(
            "registry hashes for {id} must be lowercase SHA-256 values"
        )));
    }
    if slot.publisher.publisher.is_empty()
        || slot.publisher.key_id.is_empty()
        || slot.publisher.public_key.is_empty()
        || !id.starts_with(&format!("{}.", slot.publisher.publisher))
    {
        return Err(ExtensionError::InvalidRegistry(format!(
            "publisher identity for {id} is invalid"
        )));
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn validate_trust_document(document: &TrustDocument) -> Result<(), ExtensionError> {
    if document.schema_version != TRUST_SCHEMA_VERSION {
        return Err(ExtensionError::InvalidRegistry(format!(
            "publisher trust schema version {} is unsupported",
            document.schema_version
        )));
    }
    for (key_id, publisher) in &document.publishers {
        let public_key = STANDARD.decode(&publisher.public_key).map_err(|error| {
            ExtensionError::InvalidRegistry(format!(
                "publisher key {key_id} is not valid Base64: {error}"
            ))
        })?;
        let valid_publisher = !publisher.publisher.is_empty()
            && publisher.publisher.len() <= 64
            && !publisher.publisher.starts_with('-')
            && !publisher.publisher.ends_with('-')
            && publisher
                .publisher
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
        if !valid_publisher
            || public_key.len() != 32
            || !is_sha256(key_id)
            || sideral_extension_package::sha256_hex(&public_key) != *key_id
        {
            return Err(ExtensionError::InvalidRegistry(format!(
                "publisher trust entry {key_id} is invalid"
            )));
        }
    }
    Ok(())
}

fn package_relative_path(package: &ValidatedExtensionPackage) -> String {
    let short_hash = package
        .package_sha256
        .get(..16)
        .map_or(package.package_sha256.as_str(), |value| value);
    format!(
        "{PACKAGES_DIRECTORY_NAME}/{}/{}-{short_hash}.sideralx",
        package.manifest.id, package.manifest.version
    )
}

fn persist_package(
    destination: &Path,
    bytes: &[u8],
    expected_sha256: &str,
) -> Result<(), ExtensionError> {
    if destination.exists() {
        let existing = fs::read(destination).map_err(|error| {
            ExtensionError::io(format!("could not read {}", destination.display()), error)
        })?;
        if sideral_extension_package::sha256_hex(&existing) == expected_sha256 {
            return Ok(());
        }
        return Err(ExtensionError::Conflict(format!(
            "package destination {} already contains different data",
            destination.display()
        )));
    }
    let parent = destination.parent().ok_or_else(|| {
        ExtensionError::InvalidRegistry(format!(
            "package destination {} has no parent",
            destination.display()
        ))
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        ExtensionError::io(
            format!("could not create package directory {}", parent.display()),
            error,
        )
    })?;
    let mut temporary = NamedTempFile::new_in(parent).map_err(|error| {
        ExtensionError::io(
            format!("could not create temporary package in {}", parent.display()),
            error,
        )
    })?;
    temporary
        .write_all(bytes)
        .and_then(|()| temporary.as_file_mut().sync_all())
        .map_err(|error| {
            ExtensionError::io("could not persist temporary extension package", error)
        })?;
    temporary.persist_noclobber(destination).map_err(|error| {
        ExtensionError::io(
            format!("could not install package at {}", destination.display()),
            error.error,
        )
    })?;
    Ok(())
}

fn read_package(path: &Path) -> Result<Vec<u8>, ExtensionError> {
    if path.extension().and_then(|value| value.to_str()) != Some("sideralx") {
        return Err(ExtensionError::InvalidPackage(
            "extension package must use the .sideralx suffix".to_owned(),
        ));
    }
    let file = fs::File::open(path)
        .map_err(|error| ExtensionError::io(format!("could not open {}", path.display()), error))?;
    let metadata = file.metadata().map_err(|error| {
        ExtensionError::io(format!("could not inspect {}", path.display()), error)
    })?;
    if !metadata.is_file() {
        return Err(ExtensionError::InvalidPackage(format!(
            "{} is not a regular file",
            path.display()
        )));
    }
    let size = usize::try_from(metadata.len())
        .map_err(|_| ExtensionError::InvalidPackage("extension package is too large".to_owned()))?;
    validate_package_size(size)
        .map_err(|error| ExtensionError::InvalidPackage(error.to_string()))?;
    let limit = extension_size_budget().max_compressed_package_bytes;
    read_bounded(file, limit)
        .map_err(|error| ExtensionError::io(format!("could not read {}", path.display()), error))
}

fn read_json_document<T: for<'de> Deserialize<'de>>(
    path: &Path,
    limit: u64,
) -> Result<Option<T>, ExtensionError> {
    if !path.exists() {
        return Ok(None);
    }
    let file = fs::File::open(path)
        .map_err(|error| ExtensionError::io(format!("could not open {}", path.display()), error))?;
    let metadata = file.metadata().map_err(|error| {
        ExtensionError::io(format!("could not inspect {}", path.display()), error)
    })?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err(ExtensionError::InvalidRegistry(format!(
            "{} is not a bounded registry file",
            path.display()
        )));
    }
    let source = read_bounded(
        file,
        usize::try_from(limit).map_err(|_| {
            ExtensionError::InvalidRegistry(format!("{} has an invalid size limit", path.display()))
        })?,
    )
    .map_err(|error| ExtensionError::io(format!("could not read {}", path.display()), error))?;
    serde_json::from_slice(&source)
        .map(Some)
        .map_err(|error| ExtensionError::InvalidRegistry(error.to_string()))
}

fn read_bounded(file: fs::File, limit: usize) -> std::io::Result<Vec<u8>> {
    let read_limit = u64::try_from(limit).unwrap_or(u64::MAX).saturating_add(1);
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    file.take(read_limit).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("file exceeds its {limit}-byte limit"),
        ));
    }
    Ok(bytes)
}

fn write_json_document<T: Serialize>(
    path: &Path,
    value: &T,
    limit: u64,
) -> Result<(), ExtensionError> {
    let parent = path.parent().ok_or_else(|| {
        ExtensionError::InvalidRegistry(format!("{} has no parent", path.display()))
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        ExtensionError::io(
            format!("could not create extension directory {}", parent.display()),
            error,
        )
    })?;
    let mut serialized = serde_json::to_vec_pretty(value)
        .map_err(|error| ExtensionError::InvalidRegistry(error.to_string()))?;
    serialized.push(b'\n');
    if serialized.len() as u64 > limit {
        return Err(ExtensionError::InvalidRegistry(format!(
            "{} exceeds its {limit}-byte limit",
            path.display()
        )));
    }
    let mut temporary = NamedTempFile::new_in(parent).map_err(|error| {
        ExtensionError::io(
            format!(
                "could not create temporary registry in {}",
                parent.display()
            ),
            error,
        )
    })?;
    temporary
        .write_all(&serialized)
        .and_then(|()| temporary.as_file_mut().sync_all())
        .map_err(|error| ExtensionError::io("could not persist extension registry", error))?;
    temporary.persist(path).map_err(|error| {
        ExtensionError::io(
            format!("could not atomically replace {}", path.display()),
            error.error,
        )
    })?;
    Ok(())
}

pub(crate) fn remove_installed_packages(paths: Vec<PathBuf>) -> Result<(), ExtensionError> {
    for path in paths {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(ExtensionError::io(
                    format!("could not remove {}", path.display()),
                    error,
                ));
            }
        }
    }
    Ok(())
}
