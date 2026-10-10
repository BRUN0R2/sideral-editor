# Discord Work Presence

Publishes workspace/document names and language metadata to desktop Discord.
It never receives source content or full paths. Requires Sideral `^0.1.1` and
the running Windows Discord desktop client.

## Use

Install the signed package. Its public Application ID is in the manifest;
there is no token, bot, OAuth flow or user configuration.

It activates at workbench readiness and updates from events. Activity shows
`📁 <workspace>`, `🧑‍💻 <document>` and, after five idle minutes,
`Stopped for a coffee ☕`. Keyboard, pointer, wheel or focus activity restores the
document state without sharing input contents. The explicit toggle is persisted.

Use these command-palette actions:

- **Discord: Toggle Discord Work Presence**
- **Discord: Refresh Discord Work Presence**

Connectivity failures appear in **Discord Work Presence** output. Refresh retries
after Discord becomes available. Disable, reload and shutdown clear the activity
and close its owned IPC session.

## Artwork and integration

The activity uses the [animated Sideral artwork](../../assets/discord/README.md)
and one Download button linked to the latest GitHub release. External artwork must
be anonymously accessible; Discord fetches and animates it without per-frame RPC
updates. Static Developer Portal icons use the PNG export.

The native broker owns the documented Discord RPC session. The manifest grants
only workspace metadata and Discord presence. The controller serializes updates,
deduplicates identical payloads and keeps a stable session timestamp. Its queue
starts after synchronous activation, so IPC latency does not delay activation.

References: [Discord RPC](https://github.com/discord/discord-api-docs/blob/main/developers/topics/rpc.mdx)
and [Rich Presence](https://docs.discord.com/developers/discord-social-sdk/development-guides/setting-rich-presence).

## Develop and package

From the repository root:

```powershell
npm ci
npm run sdk:build
npm run extension:discord:check
npm run extensions:package:dev
```

For a focused build use `npm run extension:discord:build`. Package checks/signing
use `build/extensions/discord-presence`. See
[authoring](../../docs/EXTENSIONS.md) and the
[capability decision](../../docs/decisions/0003-discord-presence-capability.md).
