# ADR 0003: Discord presence capability

## Status

Accepted. This decision introduced protocol 3; [ADR 0004](0004-extension-owned-previews.md)
subsequently advanced the runtime to protocol 4.

## Context

Presence needs workspace/document names and local Discord IPC. Document snapshots,
full paths and direct Worker IPC would exceed that need. A helper executable or
legacy RPC dependency would add another lifecycle.

Discord documents native RPC framing and `SET_ACTIVITY`. The desktop client and
a valid public Application ID remain required.

## Decision

Add metadata-only workspace snapshots/events, typed Discord activity methods and
`active`/`idle` window transitions. A host-owned five-minute timer sends no
keystrokes, coordinates or input contents to Workers.

A Discord grant uses a signed Application ID literal or a declared text property.
Configuration type checks prevent binding it to an executable setting. Rust
validates bounded activity fields and up to two HTTPS buttons with 32-character
labels and 512-character credential-free URLs.

The native broker implements documented little-endian version-1 RPC frames over
ten deterministic Windows named-pipe candidates. Frames, responses and I/O have
bounds, deadlines and cancellation. One actor/session belongs exclusively to one
extension generation; competing owners fail explicitly.

Clear, failure, disable, reload, host loss and shutdown remove the owner and close
its session. There is no detached helper or polling loop. This isolated native
implementation avoids adding an SDK DLL or helper for a small local RPC contract.

The [first-party extension](../../extensions/discord-presence/README.md) owns its
public Application ID and publishes metadata through a serialized controller
queue after synchronous activation. It deduplicates payloads, retains a session
timestamp, persists the explicit toggle, reports connection failures to output
and supplies a Download button.

## Consequences

- Source text and full paths never reach the presence extension or Discord.
- Installation review shows metadata and Discord grants.
- External IPC latency does not block Worker activation.
- A stopped desktop client can recover through Refresh.
- Presence cannot outlive its owning generation.
- Windows is the validated transport. Other platforms need their own implemented
  and validated IPC path before support is claimed.

References: [Discord RPC](https://github.com/discord/discord-api-docs/blob/main/developers/topics/rpc.mdx)
and [Rich Presence](https://docs.discord.com/developers/discord-social-sdk/development-guides/setting-rich-presence).
