# Discord Work Presence

First-party Sideral extension that publishes the active workspace and document names to the local Discord desktop client. It never receives document contents or full filesystem paths.

Requires Sideral Editor `^0.1.1`.

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
- Shows `📁 <workspace>`, `🧑‍💻 <document>` and, after five minutes
  without window interaction, `Stopped for a coffee ☕`.
- Shows one `Download` button that opens the latest official Sideral Editor
  release on GitHub.
- Shows a silver `S` with animated lightning on a graphite background using
  the project's [Discord artwork](../../assets/discord/README.md).
- Restores the document activity immediately after keyboard, pointer, wheel, or
  window-focus activity; no input content leaves the editor.
- Deduplicates identical activities and keeps a stable session start time.
- Persists the explicit toggle state.
- Clears and closes its owned IPC session when disabled, reloaded, or shut down.
- Reports recoverable connectivity failures in the **Discord Work Presence** output channel.

The native broker implements Discord's documented local RPC framing and
`SET_ACTIVITY` command. The extension has only `workspace: metadata` and
`discordPresence` capabilities.

Discord shows Rich Presence buttons to other users; it does not show the owner
their own button in their profile preview.

The artwork uses a public HTTPS URL in `assets.largeImage`. Its source is
`assets/discord/sideralLightning.gif` on the repository's `main` branch.
Discord must be able to fetch that file anonymously: it stays unavailable while
the repository is private or the artwork has not been published to `main`.
After publication, use **Discord: Refresh Discord Work Presence** with a build
of this extension that includes the artwork. Discord fetches and animates the
GIF; the extension does not download images or publish per-frame RPC updates.

For a static Developer Portal application icon or Rich Presence art asset, use
`assets/discord/sideralLightning.png`. Uploaded Rich Presence art assets do not
support animation; the GIF must remain available at its external URL.

Protocol references: [Discord RPC](https://github.com/discord/discord-api-docs/blob/main/developers/topics/rpc.mdx)
and [Setting Rich Presence](https://docs.discord.com/developers/discord-social-sdk/development-guides/setting-rich-presence).
The [Discord Flatpak packaging example](https://github.com/flathub/com.discordapp.Discord)
is useful context for IPC socket exposure on Linux, but Sideral's current
operational target uses the native Windows named pipe directly.

## Develop

```powershell
npm ci
npm run sdk:build
npm run typecheck --workspace sideral.discord-presence
npm run test --workspace sideral.discord-presence
npm run build --workspace sideral.discord-presence
npm run extension:tool -- check build/extensions/discord-presence
```
