# ADR 0003: Discord presence capability

## Status

Accepted.

## Context

An editor presence extension needs current work context and a durable local
connection to Discord. Giving a Worker document snapshots or filesystem paths
would exceed that need. Letting it open native IPC directly would bypass the
signed capability boundary. A bundled helper process, legacy `discord-rpc`
library or proprietary SDK DLL would add another executable or dependency and a
separate lifecycle without improving the two fields this feature publishes.

Discord documents desktop IPC framing, its handshake and `SET_ACTIVITY`. The
Discord desktop client and a valid public Application ID are still external
runtime requirements.

## Decision

- Manifest v1 gains `workspace: metadata`, which exposes only workspace name,
  active document name and language ID through a synchronous snapshot plus a
  serialized change event. File APIs continue to require `read` or
  `readWrite`.
- Configuration gains a strict `text` property. The
  `discordPresence.applicationId` grant accepts a signed literal or a reference
  to a text property declared by the same manifest. It cannot reference an
  executable property.
- API v1 exposes typed `setActivity` and `clearActivity` methods. Rust validates
  the capability again, resolves the effective Application ID and accepts only
  the supported activity types and bounded text, timestamp and asset fields.
- The native broker implements Discord's documented little-endian RPC frames
  over the ten deterministic Windows named-pipe candidates. It performs a
  version-1 handshake, answers ping frames and sends `SET_ACTIVITY`; every frame
  and unrelated response sequence is bounded and every I/O operation has a
  finite deadline and cancellation path.
- One bounded actor and pipe belong to one globally exclusive extension
  generation. A competing extension receives an explicit conflict instead of
  silently replacing the activity. Replacing the owner's Application ID
  replaces its session. Clear, failure, disable, reload, host loss and
  application shutdown remove and abort the owner. There is no polling loop or
  detached helper.
- `extensions/discord-presence` is a thin first-party client. It derives an
  activity from metadata, preserves one session start timestamp, deduplicates
  identical payloads, persists its explicit toggle and reports recoverable
  failures through its owned output channel.
- The internal host/Worker protocol moves atomically to version 2. No legacy
  protocol decoder or compatibility branch is retained.

## Consequences

- Source text and full paths never reach the Discord extension or Discord.
- The named pipe inherits Discord RPC's same-desktop-session trust boundary;
  only public application and activity metadata are sent through it.
- Installation review shows both metadata and Discord authorities explicitly.
- A missing or invalid Application ID, or a stopped Discord client, is
  recoverable with Settings plus the Refresh command; it does not require a
  Worker restart.
- Closing a generation closes its pipe, so presence cannot outlive its owner.
- The current transport is supported on Windows, the project's declared
  operational target. A future platform must implement and validate its native
  IPC path before support is claimed.
