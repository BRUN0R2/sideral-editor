# Discord Work Presence

First-party Sideral extension that publishes the active workspace and document names to the local Discord desktop client. It never receives document contents or full filesystem paths.

Requires Sideral Editor `^0.1.0`.

## Use

Install the signed `.sideralx` package and keep the Discord desktop client
running. The extension includes its public Discord Application ID in the signed
manifest, activates automatically and requires no user configuration, bot,
token or OAuth flow.

Use **Discord: Toggle Discord Work Presence** or **Discord: Refresh Discord Work
Presence** from the command palette for explicit control.

## Behavior

- Activates once the workbench is ready.
- Starts native Discord synchronization in a controller-owned background queue,
  so external IPC latency never blocks Worker activation.
- Updates on workspace, active document, or language changes without polling.
- Deduplicates identical activities and keeps a stable session start time.
- Persists the explicit toggle state.
- Clears and closes its owned IPC session when disabled, reloaded, or shut down.
- Reports recoverable connectivity failures in the **Discord Work Presence** output channel.

The native broker implements Discord's documented local RPC framing and
`SET_ACTIVITY` command. The extension has only `workspace: metadata` and
`discordPresence` capabilities.

Protocol references: [Discord RPC](https://github.com/discord/discord-api-docs/blob/main/developers/topics/rpc.mdx)
and [Setting Rich Presence](https://docs.discord.com/developers/discord-social-sdk/development-guides/setting-rich-presence).
The [Discord Flatpak packaging example](https://github.com/flathub/com.discordapp.Discord)
is useful context for IPC socket exposure on Linux, but Sideral's current
operational target uses the native Windows named pipe directly.

## Develop

```powershell
npm run typecheck --workspace sideral.discord-presence
npm run test --workspace sideral.discord-presence
npm run build --workspace sideral.discord-presence
npm run extension:tool -- check extensions/discord-presence
```
