use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{Map, Value, json};
use sideral_extension_core::{DiscordApplicationId, ExtensionManifest};
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinHandle,
};

use super::{Cancellation, CapabilityBroker, lock};
use crate::sideral_extensions::error::ExtensionError;

const SESSION_COMMAND_CAPACITY: usize = 8;
const MAX_ACTIVITY_TEXT_BYTES: usize = 128;
const MAX_ASSET_KEY_BYTES: usize = 256;
const MAX_UNIX_TIMESTAMP: i64 = 253_402_300_799;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DiscordActivityPayload {
    #[serde(default, rename = "type")]
    activity_type: DiscordActivityType,
    #[serde(default)]
    details: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    start_timestamp: Option<i64>,
    #[serde(default)]
    assets: Option<DiscordActivityAssets>,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
enum DiscordActivityType {
    #[default]
    Playing,
    Listening,
    Watching,
    Competing,
}

impl DiscordActivityType {
    const fn code(self) -> u8 {
        match self {
            Self::Playing => 0,
            Self::Listening => 2,
            Self::Watching => 3,
            Self::Competing => 5,
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiscordActivityAssets {
    #[serde(default)]
    large_image: Option<String>,
    #[serde(default)]
    large_text: Option<String>,
    #[serde(default)]
    small_image: Option<String>,
    #[serde(default)]
    small_text: Option<String>,
}

#[derive(Clone)]
struct DiscordActivity {
    activity_type: DiscordActivityType,
    details: Option<String>,
    state: Option<String>,
    start_timestamp: Option<i64>,
    assets: Option<DiscordActivityAssets>,
}

#[derive(Default)]
pub(super) struct DiscordPresenceSessions {
    owner: Mutex<Option<OwnedDiscordPresenceSession>>,
}

struct OwnedDiscordPresenceSession {
    extension_id: String,
    session: Arc<DiscordPresenceSession>,
}

struct DiscordPresenceSession {
    generation: u64,
    application_id: String,
    commands: mpsc::Sender<SessionCommand>,
    task: Mutex<Option<JoinHandle<()>>>,
}

enum SessionCommand {
    SetActivity {
        activity: DiscordActivity,
        cancellation: Arc<Cancellation>,
        response: oneshot::Sender<Result<(), ExtensionError>>,
    },
    ClearActivity {
        cancellation: Arc<Cancellation>,
        response: oneshot::Sender<Result<(), ExtensionError>>,
    },
}

impl CapabilityBroker {
    pub(super) async fn set_discord_activity(
        &self,
        manifest: &ExtensionManifest,
        generation: u64,
        payload: DiscordActivityPayload,
        cancellation: Arc<Cancellation>,
    ) -> Result<Value, ExtensionError> {
        let application_id = self.discord_application_id(manifest).await?;
        let activity = payload.validate()?;
        let session =
            self.shared
                .discord_presence
                .session(&manifest.id, generation, application_id)?;
        let result = session
            .request(SessionCommandFactory::Set(activity), cancellation)
            .await;
        if result.is_err() {
            self.shared
                .discord_presence
                .remove_if_current(&manifest.id, &session);
        }
        result?;
        Ok(Value::Null)
    }

    pub(super) async fn clear_discord_activity(
        &self,
        manifest: &ExtensionManifest,
        generation: u64,
        cancellation: Arc<Cancellation>,
    ) -> Result<Value, ExtensionError> {
        require_discord_permission(manifest)?;
        let Some(session) = self
            .shared
            .discord_presence
            .matching(&manifest.id, generation)?
        else {
            return Ok(Value::Null);
        };
        let result = session
            .request(SessionCommandFactory::Clear, cancellation)
            .await;
        if result.is_ok() {
            self.shared
                .discord_presence
                .remove_if_current(&manifest.id, &session);
        }
        result.map(|()| Value::Null)
    }

    async fn discord_application_id(
        &self,
        manifest: &ExtensionManifest,
    ) -> Result<String, ExtensionError> {
        let permission = require_discord_permission(manifest)?;
        let value = match &permission.application_id {
            DiscordApplicationId::Literal { value } => value.clone(),
            DiscordApplicationId::Configuration { key } => {
                self.configuration_value(manifest, key).await?
            }
        };
        validate_application_id(&value)?;
        Ok(value)
    }
}

enum SessionCommandFactory {
    Set(DiscordActivity),
    Clear,
}

impl DiscordPresenceSessions {
    fn session(
        &self,
        extension_id: &str,
        generation: u64,
        application_id: String,
    ) -> Result<Arc<DiscordPresenceSession>, ExtensionError> {
        let mut owner = lock(&self.owner, "Discord presence owner")?;
        if let Some(existing) = owner.as_ref() {
            if existing.extension_id == extension_id
                && existing.session.generation == generation
                && existing.session.application_id == application_id
                && !existing.session.is_finished()
            {
                return Ok(existing.session.clone());
            }
            if existing.extension_id != extension_id && !existing.session.is_finished() {
                return Err(ExtensionError::Conflict(format!(
                    "Discord presence is already owned by extension {}",
                    existing.extension_id
                )));
            }
        }
        if let Some(previous) = owner.take() {
            previous.session.abort();
        }

        let (commands, receiver) = mpsc::channel(SESSION_COMMAND_CAPACITY);
        let session = Arc::new(DiscordPresenceSession {
            generation,
            application_id: application_id.clone(),
            commands,
            task: Mutex::new(None),
        });
        let task = tokio::spawn(run_session(application_id, generation, receiver));
        *lock(&session.task, "Discord presence session task")? = Some(task);
        *owner = Some(OwnedDiscordPresenceSession {
            extension_id: extension_id.to_owned(),
            session: session.clone(),
        });
        Ok(session)
    }

    fn matching(
        &self,
        extension_id: &str,
        generation: u64,
    ) -> Result<Option<Arc<DiscordPresenceSession>>, ExtensionError> {
        Ok(lock(&self.owner, "Discord presence owner")?
            .as_ref()
            .filter(|owner| {
                owner.extension_id == extension_id && owner.session.generation == generation
            })
            .map(|owner| owner.session.clone()))
    }

    fn remove_if_current(&self, extension_id: &str, expected: &Arc<DiscordPresenceSession>) {
        if let Ok(mut owner) = self.owner.lock()
            && owner.as_ref().is_some_and(|current| {
                current.extension_id == extension_id && Arc::ptr_eq(&current.session, expected)
            })
            && let Some(removed) = owner.take()
        {
            removed.session.abort();
        }
    }

    pub(super) fn cancel_extension(&self, extension_id: &str) {
        if let Ok(mut owner) = self.owner.lock()
            && owner
                .as_ref()
                .is_some_and(|current| current.extension_id == extension_id)
            && let Some(removed) = owner.take()
        {
            removed.session.abort();
        }
    }

    pub(super) fn cancel_all(&self) {
        if let Ok(mut owner) = self.owner.lock()
            && let Some(removed) = owner.take()
        {
            removed.session.abort();
        }
    }
}

impl DiscordPresenceSession {
    fn is_finished(&self) -> bool {
        self.task.lock().map_or(true, |task| {
            task.as_ref().is_none_or(JoinHandle::is_finished)
        })
    }

    async fn request(
        &self,
        factory: SessionCommandFactory,
        cancellation: Arc<Cancellation>,
    ) -> Result<(), ExtensionError> {
        if cancellation.is_cancelled() {
            return Err(ExtensionError::Cancelled);
        }
        let (response, receiver) = oneshot::channel();
        let command = match factory {
            SessionCommandFactory::Set(activity) => SessionCommand::SetActivity {
                activity,
                cancellation: cancellation.clone(),
                response,
            },
            SessionCommandFactory::Clear => SessionCommand::ClearActivity {
                cancellation: cancellation.clone(),
                response,
            },
        };
        tokio::select! {
            result = self.commands.send(command) => result.map_err(|_| {
                ExtensionError::Runtime("Discord presence session stopped unexpectedly".to_owned())
            })?,
            () = cancellation.cancelled() => return Err(ExtensionError::Cancelled),
        }
        tokio::select! {
            result = receiver => result.map_err(|_| {
                ExtensionError::Runtime("Discord presence session stopped unexpectedly".to_owned())
            })?,
            () = cancellation.cancelled() => Err(ExtensionError::Cancelled),
        }
    }

    fn abort(&self) {
        if let Ok(mut task) = self.task.lock()
            && let Some(task) = task.take()
        {
            task.abort();
        }
    }
}

impl Drop for DiscordPresenceSession {
    fn drop(&mut self) {
        if let Ok(task) = self.task.get_mut()
            && let Some(task) = task.take()
        {
            task.abort();
        }
    }
}

async fn run_session(
    application_id: String,
    generation: u64,
    mut commands: mpsc::Receiver<SessionCommand>,
) {
    let mut transport: Option<platform::DiscordTransport> = None;
    let mut nonce_sequence = 1_u64;
    while let Some(command) = commands.recv().await {
        match command {
            SessionCommand::SetActivity {
                activity,
                cancellation,
                response,
            } => {
                let result = set_activity(
                    &mut transport,
                    &application_id,
                    generation,
                    &mut nonce_sequence,
                    &activity,
                    &cancellation,
                )
                .await;
                if result.is_err() {
                    transport = None;
                }
                let _ = response.send(result);
            }
            SessionCommand::ClearActivity {
                cancellation,
                response,
            } => {
                let result = clear_activity(
                    transport.as_mut(),
                    generation,
                    &mut nonce_sequence,
                    &cancellation,
                )
                .await;
                let should_stop = result.is_ok();
                let _ = response.send(result);
                if should_stop {
                    return;
                }
                transport = None;
            }
        }
    }
}

async fn set_activity(
    transport: &mut Option<platform::DiscordTransport>,
    application_id: &str,
    generation: u64,
    nonce_sequence: &mut u64,
    activity: &DiscordActivity,
    cancellation: &Cancellation,
) -> Result<(), ExtensionError> {
    if cancellation.is_cancelled() {
        return Err(ExtensionError::Cancelled);
    }
    if transport.is_none() {
        *transport = Some(platform::DiscordTransport::connect(application_id, cancellation).await?);
    }
    let nonce = next_nonce(generation, nonce_sequence)?;
    let payload = json!({
        "cmd": "SET_ACTIVITY",
        "args": {
            "pid": std::process::id(),
            "activity": activity.rpc_value(),
        },
        "nonce": nonce,
    });
    transport
        .as_mut()
        .ok_or_else(|| ExtensionError::Runtime("Discord IPC transport is unavailable".to_owned()))?
        .request(payload, &nonce, cancellation)
        .await
}

async fn clear_activity(
    transport: Option<&mut platform::DiscordTransport>,
    generation: u64,
    nonce_sequence: &mut u64,
    cancellation: &Cancellation,
) -> Result<(), ExtensionError> {
    let Some(transport) = transport else {
        return Ok(());
    };
    let nonce = next_nonce(generation, nonce_sequence)?;
    transport
        .request(
            json!({
                "cmd": "SET_ACTIVITY",
                "args": { "pid": std::process::id(), "activity": Value::Null },
                "nonce": nonce,
            }),
            &nonce,
            cancellation,
        )
        .await
}

fn next_nonce(generation: u64, sequence: &mut u64) -> Result<String, ExtensionError> {
    let current = *sequence;
    *sequence = sequence.checked_add(1).ok_or_else(|| {
        ExtensionError::Runtime("Discord presence nonce sequence was exhausted".to_owned())
    })?;
    Ok(format!("sideral-{generation}-{current}"))
}

impl DiscordActivityPayload {
    fn validate(self) -> Result<DiscordActivity, ExtensionError> {
        if self.details.is_none() && self.state.is_none() {
            return Err(ExtensionError::InvalidRequest(
                "Discord activity requires details or state".to_owned(),
            ));
        }
        validate_optional_text(
            "activity details",
            self.details.as_deref(),
            MAX_ACTIVITY_TEXT_BYTES,
        )?;
        validate_optional_text(
            "activity state",
            self.state.as_deref(),
            MAX_ACTIVITY_TEXT_BYTES,
        )?;
        if let Some(timestamp) = self.start_timestamp
            && !(1..=MAX_UNIX_TIMESTAMP).contains(&timestamp)
        {
            return Err(ExtensionError::InvalidRequest(
                "Discord activity start timestamp is outside the supported Unix range".to_owned(),
            ));
        }
        if let Some(assets) = &self.assets {
            if assets.large_image.is_none()
                && assets.large_text.is_none()
                && assets.small_image.is_none()
                && assets.small_text.is_none()
            {
                return Err(ExtensionError::InvalidRequest(
                    "Discord activity assets cannot be empty".to_owned(),
                ));
            }
            validate_optional_text(
                "large image key",
                assets.large_image.as_deref(),
                MAX_ASSET_KEY_BYTES,
            )?;
            validate_optional_text(
                "large image text",
                assets.large_text.as_deref(),
                MAX_ACTIVITY_TEXT_BYTES,
            )?;
            validate_optional_text(
                "small image key",
                assets.small_image.as_deref(),
                MAX_ASSET_KEY_BYTES,
            )?;
            validate_optional_text(
                "small image text",
                assets.small_text.as_deref(),
                MAX_ACTIVITY_TEXT_BYTES,
            )?;
        }
        Ok(DiscordActivity {
            activity_type: self.activity_type,
            details: self.details,
            state: self.state,
            start_timestamp: self.start_timestamp,
            assets: self.assets,
        })
    }
}

impl DiscordActivity {
    fn rpc_value(&self) -> Value {
        let mut activity = Map::new();
        activity.insert("type".to_owned(), Value::from(self.activity_type.code()));
        if let Some(details) = &self.details {
            activity.insert("details".to_owned(), Value::String(details.clone()));
        }
        if let Some(state) = &self.state {
            activity.insert("state".to_owned(), Value::String(state.clone()));
        }
        if let Some(start) = self.start_timestamp {
            activity.insert("timestamps".to_owned(), json!({ "start": start }));
        }
        if let Some(assets) = &self.assets {
            let mut value = Map::new();
            insert_optional(&mut value, "large_image", &assets.large_image);
            insert_optional(&mut value, "large_text", &assets.large_text);
            insert_optional(&mut value, "small_image", &assets.small_image);
            insert_optional(&mut value, "small_text", &assets.small_text);
            activity.insert("assets".to_owned(), Value::Object(value));
        }
        Value::Object(activity)
    }
}

fn insert_optional(target: &mut Map<String, Value>, key: &str, value: &Option<String>) {
    if let Some(value) = value {
        target.insert(key.to_owned(), Value::String(value.clone()));
    }
}

fn require_discord_permission(
    manifest: &ExtensionManifest,
) -> Result<&sideral_extension_core::DiscordPresencePermission, ExtensionError> {
    manifest
        .permissions
        .discord_presence
        .as_ref()
        .ok_or_else(|| {
            ExtensionError::PermissionDenied(format!(
                "extension {} does not have Discord presence access",
                manifest.id
            ))
        })
}

fn validate_application_id(value: &str) -> Result<(), ExtensionError> {
    if !(17..=20).contains(&value.len())
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || value.bytes().all(|byte| byte == b'0')
    {
        return Err(ExtensionError::InvalidRequest(
            "Discord application ID must contain 17 to 20 decimal digits and cannot be zero"
                .to_owned(),
        ));
    }
    Ok(())
}

fn validate_optional_text(
    field: &str,
    value: Option<&str>,
    maximum_bytes: usize,
) -> Result<(), ExtensionError> {
    let Some(value) = value else {
        return Ok(());
    };
    if value.is_empty()
        || value.trim() != value
        || value.len() > maximum_bytes
        || value.chars().any(char::is_control)
    {
        return Err(ExtensionError::InvalidRequest(format!(
            "Discord {field} must be clean text of at most {maximum_bytes} bytes"
        )));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
mod platform {
    use std::{future::Future, io, time::Duration};

    use serde_json::{Value, json};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::windows::named_pipe::{ClientOptions, NamedPipeClient},
        time::timeout,
    };

    use super::{Cancellation, ExtensionError};

    const RPC_VERSION: u8 = 1;
    const PIPE_CANDIDATES: u8 = 10;
    const MAX_FRAME_BYTES: usize = 64 * 1024;
    const MAX_IGNORED_FRAMES: usize = 32;
    const IO_DEADLINE: Duration = Duration::from_secs(5);
    const OPCODE_HANDSHAKE: u32 = 0;
    const OPCODE_FRAME: u32 = 1;
    const OPCODE_CLOSE: u32 = 2;
    const OPCODE_PING: u32 = 3;
    const OPCODE_PONG: u32 = 4;

    pub(super) struct DiscordTransport {
        pipe: NamedPipeClient,
    }

    struct RpcFrame {
        opcode: u32,
        payload: Vec<u8>,
    }

    impl DiscordTransport {
        pub(super) async fn connect(
            application_id: &str,
            cancellation: &Cancellation,
        ) -> Result<Self, ExtensionError> {
            if cancellation.is_cancelled() {
                return Err(ExtensionError::Cancelled);
            }
            let mut failures = Vec::with_capacity(usize::from(PIPE_CANDIDATES));
            let mut pipe = None;
            for index in 0..PIPE_CANDIDATES {
                let path = format!(r"\\?\pipe\discord-ipc-{index}");
                match ClientOptions::new().open(&path) {
                    Ok(candidate) => {
                        pipe = Some(candidate);
                        break;
                    }
                    Err(error) => failures.push(format!("{index}:{}", error.kind())),
                }
            }
            let mut transport = Self {
                pipe: pipe.ok_or_else(|| {
                    ExtensionError::Runtime(format!(
                        "could not connect to a running Discord desktop client ({})",
                        failures.join(", ")
                    ))
                })?,
            };
            transport
                .write_frame(
                    OPCODE_HANDSHAKE,
                    &json!({ "v": RPC_VERSION, "client_id": application_id }),
                    cancellation,
                )
                .await?;
            let ready = transport.read_json(cancellation).await?;
            if ready.get("evt").and_then(Value::as_str) != Some("READY") {
                return Err(rpc_error("Discord rejected the IPC handshake", &ready));
            }
            Ok(transport)
        }

        pub(super) async fn request(
            &mut self,
            payload: Value,
            nonce: &str,
            cancellation: &Cancellation,
        ) -> Result<(), ExtensionError> {
            self.write_frame(OPCODE_FRAME, &payload, cancellation)
                .await?;
            for _ in 0..MAX_IGNORED_FRAMES {
                let response = self.read_json(cancellation).await?;
                if response.get("nonce").and_then(Value::as_str) != Some(nonce) {
                    continue;
                }
                if response.get("evt").and_then(Value::as_str) == Some("ERROR") {
                    return Err(rpc_error("Discord rejected the activity", &response));
                }
                return Ok(());
            }
            Err(ExtensionError::Runtime(
                "Discord IPC returned too many unrelated frames".to_owned(),
            ))
        }

        async fn write_frame(
            &mut self,
            opcode: u32,
            payload: &Value,
            cancellation: &Cancellation,
        ) -> Result<(), ExtensionError> {
            let payload = serde_json::to_vec(payload)
                .map_err(|error| ExtensionError::Runtime(error.to_string()))?;
            self.write_raw_frame(opcode, &payload, cancellation).await
        }

        async fn write_raw_frame(
            &mut self,
            opcode: u32,
            payload: &[u8],
            cancellation: &Cancellation,
        ) -> Result<(), ExtensionError> {
            let frame = encode_frame(opcode, payload)?;
            cancellable_io(
                cancellation,
                self.pipe.write_all(&frame),
                "write Discord IPC frame",
            )
            .await
        }

        async fn read_json(
            &mut self,
            cancellation: &Cancellation,
        ) -> Result<Value, ExtensionError> {
            loop {
                let frame = self.read_frame(cancellation).await?;
                match frame.opcode {
                    OPCODE_FRAME | OPCODE_HANDSHAKE => {
                        return serde_json::from_slice(&frame.payload).map_err(|error| {
                            ExtensionError::Runtime(format!(
                                "Discord IPC returned invalid JSON: {error}"
                            ))
                        });
                    }
                    OPCODE_PING => {
                        self.write_raw_frame(OPCODE_PONG, &frame.payload, cancellation)
                            .await?;
                    }
                    OPCODE_CLOSE => {
                        let reason = serde_json::from_slice::<Value>(&frame.payload)
                            .unwrap_or_else(|_| Value::String("unknown reason".to_owned()));
                        return Err(rpc_error("Discord closed the IPC connection", &reason));
                    }
                    opcode => {
                        return Err(ExtensionError::Runtime(format!(
                            "Discord IPC returned unsupported opcode {opcode}"
                        )));
                    }
                }
            }
        }

        async fn read_frame(
            &mut self,
            cancellation: &Cancellation,
        ) -> Result<RpcFrame, ExtensionError> {
            let mut header = [0_u8; 8];
            cancellable_io(
                cancellation,
                self.pipe.read_exact(&mut header),
                "read Discord IPC frame header",
            )
            .await?;
            let (opcode, length) = decode_header(header)?;
            let mut payload = vec![0_u8; length];
            cancellable_io(
                cancellation,
                self.pipe.read_exact(&mut payload),
                "read Discord IPC frame payload",
            )
            .await?;
            Ok(RpcFrame { opcode, payload })
        }
    }

    fn encode_frame(opcode: u32, payload: &[u8]) -> Result<Vec<u8>, ExtensionError> {
        if payload.len() > MAX_FRAME_BYTES {
            return Err(ExtensionError::InvalidRequest(
                "Discord IPC frame exceeds its size limit".to_owned(),
            ));
        }
        let length = u32::try_from(payload.len()).map_err(|_| {
            ExtensionError::InvalidRequest("Discord IPC frame is too large".to_owned())
        })?;
        let mut frame = Vec::with_capacity(8 + payload.len());
        frame.extend_from_slice(&opcode.to_le_bytes());
        frame.extend_from_slice(&length.to_le_bytes());
        frame.extend_from_slice(payload);
        Ok(frame)
    }

    fn decode_header(header: [u8; 8]) -> Result<(u32, usize), ExtensionError> {
        let opcode = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
        let length = u32::from_le_bytes([header[4], header[5], header[6], header[7]]) as usize;
        if length > MAX_FRAME_BYTES {
            return Err(ExtensionError::Runtime(format!(
                "Discord IPC frame exceeds {MAX_FRAME_BYTES} bytes"
            )));
        }
        Ok((opcode, length))
    }

    async fn cancellable_io<T, Operation>(
        cancellation: &Cancellation,
        operation: Operation,
        context: &'static str,
    ) -> Result<T, ExtensionError>
    where
        Operation: Future<Output = io::Result<T>>,
    {
        tokio::select! {
            () = cancellation.cancelled() => Err(ExtensionError::Cancelled),
            result = timeout(IO_DEADLINE, operation) => match result {
                Ok(Ok(value)) => Ok(value),
                Ok(Err(error)) => Err(ExtensionError::io(context, error)),
                Err(_) => Err(ExtensionError::DeadlineExceeded),
            },
        }
    }

    fn rpc_error(context: &str, payload: &Value) -> ExtensionError {
        let message = payload
            .pointer("/data/message")
            .and_then(Value::as_str)
            .or_else(|| payload.get("message").and_then(Value::as_str))
            .unwrap_or("unknown Discord RPC error");
        ExtensionError::Runtime(format!("{context}: {message}"))
    }

    #[cfg(test)]
    mod tests {
        use serde_json::{Value, json};

        use super::{OPCODE_HANDSHAKE, decode_header, encode_frame};

        #[test]
        fn encodes_the_documented_little_endian_frame_header()
        -> Result<(), Box<dyn std::error::Error>> {
            let payload = json!({ "v": 1, "client_id": "123456789012345678" });
            let payload_bytes = serde_json::to_vec(&payload)?;
            let frame = encode_frame(OPCODE_HANDSHAKE, &payload_bytes)?;
            let header: [u8; 8] = frame[..8].try_into()?;
            let (opcode, length) = decode_header(header)?;
            let decoded: Value = serde_json::from_slice(&frame[8..])?;

            assert_eq!(opcode, OPCODE_HANDSHAKE);
            assert_eq!(length, frame.len() - 8);
            assert_eq!(decoded, payload);
            Ok(())
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use serde_json::Value;

    use super::{Cancellation, ExtensionError};

    pub(super) struct DiscordTransport;

    impl DiscordTransport {
        pub(super) async fn connect(
            _application_id: &str,
            _cancellation: &Cancellation,
        ) -> Result<Self, ExtensionError> {
            Err(ExtensionError::Runtime(
                "Discord presence is currently supported only on Windows".to_owned(),
            ))
        }

        pub(super) async fn request(
            &mut self,
            _payload: Value,
            _nonce: &str,
            _cancellation: &Cancellation,
        ) -> Result<(), ExtensionError> {
            Err(ExtensionError::Runtime(
                "Discord presence is currently supported only on Windows".to_owned(),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::{DiscordActivityPayload, DiscordPresenceSessions, validate_application_id};

    const APPLICATION_ID: &str = "123456789012345678";

    #[test]
    fn validates_bounded_activity_payloads() {
        let valid = serde_json::from_value::<DiscordActivityPayload>(json!({
            "type": "playing",
            "details": "Editing main.rs",
            "state": "Workspace: sideral-editor",
            "startTimestamp": 1_725_000_000,
        }));
        assert!(valid.is_ok_and(|payload| payload.validate().is_ok()));

        let empty = serde_json::from_value::<DiscordActivityPayload>(json!({}));
        assert!(empty.is_ok_and(|payload| payload.validate().is_err()));
        assert!(validate_application_id("12345678901234567").is_ok());
        assert!(validate_application_id("00000000000000000").is_err());
        assert!(validate_application_id("not-an-id").is_err());
    }

    #[tokio::test]
    async fn grants_one_live_presence_owner() -> Result<(), Box<dyn std::error::Error>> {
        let sessions = DiscordPresenceSessions::default();
        let first = sessions.session("first.extension", 1, APPLICATION_ID.to_owned())?;
        let same_owner = sessions.session("first.extension", 1, APPLICATION_ID.to_owned())?;

        assert!(Arc::ptr_eq(&first, &same_owner));
        assert!(matches!(
            sessions.session("second.extension", 1, APPLICATION_ID.to_owned()),
            Err(super::ExtensionError::Conflict(message))
                if message.contains("first.extension")
        ));

        sessions.cancel_all();
        Ok(())
    }
}
