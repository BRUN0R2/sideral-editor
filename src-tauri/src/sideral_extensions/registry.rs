use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use sideral_extension_core::{ExtensionManifest, normalize_keybinding, validate_package_path};
use sideral_extension_package::{
    PublisherIdentity, ValidatedExtensionPackage, validate_package_bytes,
};

mod persistence;

pub(crate) use persistence::remove_installed_packages;
use persistence::{
    package_relative_path, persist_package, read_json_document, read_package, write_json_document,
};

use super::{
    error::ExtensionError,
    protocol::{
        ExtensionCommandView, ExtensionKeybindingView, ExtensionLanguageView,
        ExtensionRuntimeState, ExtensionSnapshot, InstalledExtensionView, KeybindingUpdate,
        PackageInstallView, RuntimeDiagnostic,
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
            languages: package.manifest.contributes.languages.clone(),
            configuration: package.manifest.contributes.configuration.clone(),
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
        self.ensure_contributions_available(&package.manifest)?;
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
        self.ensure_contributions_available(&package.manifest)?;
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
        self.ensure_contributions_available(&rollback.manifest)?;
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
        self.validate_installed_slot(rollback)?;
        self.ensure_contributions_available(&rollback.manifest)
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

    pub fn configurable_manifests(&self) -> Vec<ExtensionManifest> {
        self.document
            .extensions
            .values()
            .map(|installed| &installed.active.manifest)
            .filter(|manifest| manifest.contributes.configuration.is_some())
            .cloned()
            .collect()
    }

    pub fn configuration_manifest(
        &self,
        extension_id: &str,
    ) -> Result<ExtensionManifest, ExtensionError> {
        self.document
            .extensions
            .get(extension_id)
            .map(|installed| installed.active.manifest.clone())
            .ok_or_else(|| ExtensionError::NotFound(extension_id.to_owned()))
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
        let mut languages = Vec::new();
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
            let extension_languages = installed
                .active
                .manifest
                .contributes
                .languages
                .iter()
                .map(|language| ExtensionLanguageView::from_contribution(extension_id, language))
                .collect::<Vec<_>>();
            if installed.enabled {
                commands.extend(extension_commands.iter().cloned());
                languages.extend(extension_languages.iter().cloned());
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
                languages: extension_languages,
                configuration: installed.active.manifest.contributes.configuration.clone(),
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
            languages,
        }
    }

    fn ensure_contributions_available(
        &self,
        manifest: &ExtensionManifest,
    ) -> Result<(), ExtensionError> {
        self.ensure_command_ids_available(manifest)?;
        self.ensure_language_contributions_available(manifest)
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

    fn ensure_language_contributions_available(
        &self,
        manifest: &ExtensionManifest,
    ) -> Result<(), ExtensionError> {
        for language in &manifest.contributes.languages {
            for (extension_id, installed) in &self.document.extensions {
                if extension_id == &manifest.id {
                    continue;
                }
                for existing_manifest in std::iter::once(&installed.active.manifest)
                    .chain(installed.rollback.iter().map(|slot| &slot.manifest))
                {
                    for existing in &existing_manifest.contributes.languages {
                        if existing.id == language.id {
                            return Err(ExtensionError::Conflict(format!(
                                "language {} is already contributed by {extension_id}",
                                language.id
                            )));
                        }
                        if let Some(extension) = language
                            .extensions
                            .iter()
                            .find(|extension| existing.extensions.contains(extension))
                        {
                            return Err(ExtensionError::Conflict(format!(
                                "language extension {extension} is already contributed by {extension_id}"
                            )));
                        }
                    }
                }
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

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, env, path::PathBuf};

    use semver::Version;
    use tempfile::tempdir;

    use super::{ExtensionRegistry, RegistryDocument};
    use crate::sideral_extensions::error::ExtensionError;

    #[test]
    fn rejects_registry_documents_without_keybinding_overrides() {
        let source = r#"{
            "schemaVersion": 1,
            "revision": 0,
            "extensions": {}
        }"#;

        assert!(serde_json::from_str::<RegistryDocument>(source).is_err());
    }

    #[test]
    #[ignore = "requires SIDERAL_EXTENSION_E2E_PACKAGE"]
    fn installs_and_restores_a_real_signed_extension_package() -> Result<(), ExtensionError> {
        let package_path =
            PathBuf::from(env::var("SIDERAL_EXTENSION_E2E_PACKAGE").map_err(|error| {
                ExtensionError::InvalidRequest(format!("package environment is missing: {error}"))
            })?);
        let directory = tempdir().map_err(|error| {
            ExtensionError::io("could not create registry E2E directory", error)
        })?;
        let root = directory.path().join("extensions");
        let mut registry = ExtensionRegistry::load(
            root.clone(),
            Version::parse("0.1.0").map_err(|error| ExtensionError::Runtime(error.to_string()))?,
        )?;
        let package = registry.inspect_package(&package_path)?;
        let view = registry.package_install_view(&package);
        let extension_id = view.id.clone();
        let command_ids = view
            .commands
            .iter()
            .map(|command| command.id.clone())
            .collect::<Vec<_>>();
        let language_ids = view
            .languages
            .iter()
            .map(|language| language.id.clone())
            .collect::<Vec<_>>();

        registry.install_package(&package_path, &package.package_sha256, true)?;
        let snapshot = registry.snapshot(&BTreeMap::new());
        assert!(
            snapshot
                .extensions
                .iter()
                .any(|extension| extension.id == extension_id)
        );
        assert!(command_ids.iter().all(|expected| {
            snapshot
                .commands
                .iter()
                .any(|command| command.id == *expected)
        }));
        assert!(language_ids.iter().all(|expected| {
            snapshot
                .languages
                .iter()
                .any(|language| language.id == *expected)
        }));

        let restored = ExtensionRegistry::load(
            root,
            Version::parse("0.1.0").map_err(|error| ExtensionError::Runtime(error.to_string()))?,
        )?;
        let restored_snapshot = restored.snapshot(&BTreeMap::new());
        assert_eq!(restored_snapshot.extensions.len(), 1);
        assert_eq!(restored_snapshot.extensions[0].id, extension_id);
        Ok(())
    }
}
