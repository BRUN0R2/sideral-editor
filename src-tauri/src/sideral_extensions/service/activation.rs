use std::sync::Arc;

use serde_json::Value;
use sideral_extension_core::CommandInvocation;
use tokio::{
    sync::{Semaphore, oneshot},
    task::JoinSet,
};

use super::{
    HOST_RESPONSE_MARGIN_MILLISECONDS, SideralExtensionState, elapsed_milliseconds, lock,
    validate_active_text_document, validate_command_id,
};
use crate::sideral_extensions::{
    error::ExtensionError,
    protocol::{
        ActivationReason, COMMAND_EXECUTION_DEADLINE_MILLISECONDS, EXTENSION_PROTOCOL_VERSION,
        ExtensionRuntimeState, HostInstruction, ProtocolFailure, TextDocumentView,
        WORKER_ACTIVATION_DEADLINE_MILLISECONDS, WORKER_START_DEADLINE_MILLISECONDS,
    },
};

const MAX_CONCURRENT_ACTIVATIONS: usize = 8;
const MAX_COMMAND_ARGUMENT_BYTES: usize = 256 * 1024;

impl SideralExtensionState {
    pub async fn execute_command(
        &self,
        command_id: String,
        arguments: Vec<Value>,
        active_text_document: Option<TextDocumentView>,
    ) -> Result<Option<Value>, ExtensionError> {
        validate_command_id(&command_id)?;
        let argument_bytes = serde_json::to_vec(&arguments)
            .map_err(|error| ExtensionError::InvalidRequest(error.to_string()))?
            .len();
        if argument_bytes > MAX_COMMAND_ARGUMENT_BYTES {
            return Err(ExtensionError::InvalidRequest(format!(
                "command arguments exceed {MAX_COMMAND_ARGUMENT_BYTES} bytes"
            )));
        }
        self.require_host_connected()?;

        let (extension_id, api_version, bundle_sha256, command_ids, workspace_access, invocation) = {
            let registry = lock(&self.service.registry, "extension registry")?;
            let installed = registry.extension_for_command(&command_id)?;
            registry.active(&installed.active.manifest.id)?;
            let invocation = installed
                .active
                .manifest
                .contributes
                .commands
                .iter()
                .find(|command| command.id == command_id)
                .map(|command| command.invocation)
                .ok_or_else(|| ExtensionError::NotFound(command_id.clone()))?;
            (
                installed.active.manifest.id.clone(),
                installed.active.manifest.api_version,
                installed.active.bundle_sha256.clone(),
                installed
                    .active
                    .manifest
                    .contributes
                    .commands
                    .iter()
                    .map(|command| command.id.clone())
                    .collect::<Vec<_>>(),
                installed.active.manifest.permissions.workspace,
                invocation,
            )
        };
        let active_text_document = match invocation {
            CommandInvocation::Workbench => None,
            CommandInvocation::ActiveTextDocument => {
                Some(active_text_document.ok_or_else(|| {
                    ExtensionError::InvalidRequest(format!(
                        "command {command_id} requires an active text document"
                    ))
                })?)
            }
        };
        if let Some(document) = &active_text_document {
            validate_active_text_document(document)?;
        }
        let activation_reason = ActivationReason::Command {
            command_id: command_id.clone(),
        };
        let generation = {
            let mut runtimes = lock(&self.service.runtimes, "extension runtime state")?;
            let diagnostic = runtimes.diagnostic_mut(&extension_id);
            match diagnostic.state {
                ExtensionRuntimeState::Dormant | ExtensionRuntimeState::Stopped => {
                    diagnostic.generation = diagnostic.generation.saturating_add(1);
                    diagnostic.state = ExtensionRuntimeState::Starting;
                    diagnostic.activation_reason = Some(activation_reason.clone());
                    diagnostic.last_error = None;
                }
                ExtensionRuntimeState::Starting
                | ExtensionRuntimeState::Activating
                | ExtensionRuntimeState::Active => {}
                ExtensionRuntimeState::Stopping => {
                    return Err(ExtensionError::InvalidRuntimeState(format!(
                        "extension {extension_id} is stopping"
                    )));
                }
                ExtensionRuntimeState::Failed => {
                    return Err(ExtensionError::InvalidRuntimeState(format!(
                        "extension {extension_id} failed and must be restarted explicitly"
                    )));
                }
            }
            diagnostic.generation
        };
        self.publish_snapshot()?;

        let command_started = std::time::Instant::now();
        let request_id = self.next_request_id();
        let (sender, receiver) = oneshot::channel();
        lock(&self.service.pending, "extension pending requests")?
            .insert(request_id.clone(), sender);
        let instruction = HostInstruction::ExecuteCommand {
            protocol_version: EXTENSION_PROTOCOL_VERSION,
            request_id: request_id.clone(),
            extension_id: extension_id.clone(),
            generation,
            api_version,
            bundle_sha256,
            extension_uri: format!("sideral-extension:/{extension_id}/"),
            storage_uri: format!("sideral-storage:/{extension_id}/"),
            command_ids,
            workspace_access,
            command_id,
            arguments,
            active_text_document,
            activation_reason,
            start_deadline_milliseconds: WORKER_START_DEADLINE_MILLISECONDS,
            activation_deadline_milliseconds: WORKER_ACTIVATION_DEADLINE_MILLISECONDS,
            execution_deadline_milliseconds: COMMAND_EXECUTION_DEADLINE_MILLISECONDS,
        };
        if let Err(error) = self.send_to_host(instruction) {
            lock(&self.service.pending, "extension pending requests")?.remove(&request_id);
            self.mark_failed(
                &extension_id,
                generation,
                ProtocolFailure {
                    code: error.code().to_owned(),
                    message: error.to_string(),
                },
            )?;
            self.record_command(
                &extension_id,
                generation,
                elapsed_milliseconds(command_started),
                true,
            )?;
            return Err(error);
        }

        let total_deadline = WORKER_START_DEADLINE_MILLISECONDS
            + WORKER_ACTIVATION_DEADLINE_MILLISECONDS
            + COMMAND_EXECUTION_DEADLINE_MILLISECONDS
            + HOST_RESPONSE_MARGIN_MILLISECONDS;
        let outcome = match tokio::time::timeout(
            std::time::Duration::from_millis(total_deadline),
            receiver,
        )
        .await
        {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(ExtensionError::HostUnavailable),
            Err(_) => {
                lock(&self.service.pending, "extension pending requests")?.remove(&request_id);
                let cancellation_result = self.send_to_host(HostInstruction::CancelRequest {
                    protocol_version: EXTENSION_PROTOCOL_VERSION,
                    request_id,
                    extension_id: extension_id.clone(),
                    generation,
                });
                self.mark_failed(
                    &extension_id,
                    generation,
                    ProtocolFailure {
                        code: "deadline_exceeded".to_owned(),
                        message: "extension command exceeded its host deadline".to_owned(),
                    },
                )?;
                match cancellation_result {
                    Ok(()) => Err(ExtensionError::DeadlineExceeded),
                    Err(cancellation_error) => Err(ExtensionError::Runtime(format!(
                        "extension command exceeded its host deadline; cancellation delivery also failed: {cancellation_error}"
                    ))),
                }
            }
        };
        self.record_command(
            &extension_id,
            generation,
            elapsed_milliseconds(command_started),
            outcome.is_err(),
        )?;
        outcome
    }

    pub async fn activate_extensions(
        &self,
        reason: ActivationReason,
    ) -> Result<(), ExtensionError> {
        let event = match &reason {
            ActivationReason::WorkbenchReady => "onWorkbenchReady".to_owned(),
            ActivationReason::Language { language_id } => {
                if language_id.is_empty()
                    || language_id.len() > 64
                    || !language_id.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'+')
                    })
                {
                    return Err(ExtensionError::InvalidRequest(
                        "language activation id is invalid".to_owned(),
                    ));
                }
                format!("onLanguage:{language_id}")
            }
            ActivationReason::Command { .. } => {
                return Err(ExtensionError::InvalidRequest(
                    "command activation is implicit in command execution".to_owned(),
                ));
            }
        };
        let extension_ids =
            lock(&self.service.registry, "extension registry")?.extensions_for_activation(&event);
        let mut failures = Vec::new();
        let activation_slots = Arc::new(Semaphore::new(MAX_CONCURRENT_ACTIVATIONS));
        let mut activations = JoinSet::new();
        for extension_id in extension_ids {
            let state = self.clone();
            let activation_reason = reason.clone();
            let activation_slots = activation_slots.clone();
            activations.spawn(async move {
                let permit = activation_slots.acquire_owned().await.map_err(|_| {
                    ExtensionError::Runtime("extension activation pool is unavailable".to_owned())
                })?;
                let result = state
                    .activate_extension(extension_id.clone(), activation_reason)
                    .await;
                drop(permit);
                Ok::<_, ExtensionError>((extension_id, result))
            });
        }
        while let Some(completed) = activations.join_next().await {
            match completed {
                Ok(Ok((extension_id, Err(error)))) => {
                    failures.push(format!("{extension_id}: {error}"));
                }
                Ok(Ok((_, Ok(())))) => {}
                Ok(Err(error)) => failures.push(error.to_string()),
                Err(error) => failures.push(format!("extension activation task failed: {error}")),
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(ExtensionError::Runtime(format!(
                "extension activation failed: {}",
                failures.join("; ")
            )))
        }
    }

    async fn activate_extension(
        &self,
        extension_id: String,
        activation_reason: ActivationReason,
    ) -> Result<(), ExtensionError> {
        self.require_host_connected()?;
        let (api_version, bundle_sha256, command_ids, workspace_access) = {
            let registry = lock(&self.service.registry, "extension registry")?;
            let installed = registry.active(&extension_id)?;
            (
                installed.active.manifest.api_version,
                installed.active.bundle_sha256.clone(),
                installed
                    .active
                    .manifest
                    .contributes
                    .commands
                    .iter()
                    .map(|command| command.id.clone())
                    .collect::<Vec<_>>(),
                installed.active.manifest.permissions.workspace,
            )
        };
        let generation = {
            let mut runtimes = lock(&self.service.runtimes, "extension runtime state")?;
            let diagnostic = runtimes.diagnostic_mut(&extension_id);
            match diagnostic.state {
                ExtensionRuntimeState::Dormant | ExtensionRuntimeState::Stopped => {
                    diagnostic.generation = diagnostic.generation.saturating_add(1);
                    diagnostic.state = ExtensionRuntimeState::Starting;
                    diagnostic.activation_reason = Some(activation_reason.clone());
                    diagnostic.last_error = None;
                }
                ExtensionRuntimeState::Active => return Ok(()),
                ExtensionRuntimeState::Starting | ExtensionRuntimeState::Activating => {}
                ExtensionRuntimeState::Stopping => {
                    return Err(ExtensionError::InvalidRuntimeState(format!(
                        "extension {extension_id} is stopping"
                    )));
                }
                ExtensionRuntimeState::Failed => {
                    return Err(ExtensionError::InvalidRuntimeState(format!(
                        "extension {extension_id} failed and must be restarted explicitly"
                    )));
                }
            }
            diagnostic.generation
        };
        self.publish_snapshot()?;
        let request_id = self.next_request_id();
        let (sender, receiver) = oneshot::channel();
        lock(&self.service.pending, "extension pending requests")?
            .insert(request_id.clone(), sender);
        let instruction = HostInstruction::ActivateExtension {
            protocol_version: EXTENSION_PROTOCOL_VERSION,
            request_id: request_id.clone(),
            extension_id: extension_id.clone(),
            generation,
            api_version,
            bundle_sha256,
            extension_uri: format!("sideral-extension:/{extension_id}/"),
            storage_uri: format!("sideral-storage:/{extension_id}/"),
            command_ids,
            workspace_access,
            activation_reason,
            start_deadline_milliseconds: WORKER_START_DEADLINE_MILLISECONDS,
            activation_deadline_milliseconds: WORKER_ACTIVATION_DEADLINE_MILLISECONDS,
        };
        if let Err(error) = self.send_to_host(instruction) {
            lock(&self.service.pending, "extension pending requests")?.remove(&request_id);
            self.mark_failed(
                &extension_id,
                generation,
                ProtocolFailure {
                    code: error.code().to_owned(),
                    message: error.to_string(),
                },
            )?;
            return Err(error);
        }
        let deadline = WORKER_START_DEADLINE_MILLISECONDS
            + WORKER_ACTIVATION_DEADLINE_MILLISECONDS
            + HOST_RESPONSE_MARGIN_MILLISECONDS;
        match tokio::time::timeout(std::time::Duration::from_millis(deadline), receiver).await {
            Ok(Ok(result)) => result.map(|_| ()),
            Ok(Err(_)) => Err(ExtensionError::HostUnavailable),
            Err(_) => {
                lock(&self.service.pending, "extension pending requests")?.remove(&request_id);
                self.mark_failed(
                    &extension_id,
                    generation,
                    ProtocolFailure {
                        code: "activation_deadline_exceeded".to_owned(),
                        message: "extension activation exceeded its host deadline".to_owned(),
                    },
                )?;
                Err(ExtensionError::DeadlineExceeded)
            }
        }
    }
}
