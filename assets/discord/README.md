# Discord artwork

A stationary silver S sits above animated white lightning on the editor's graphite
background. The image-generation tool produced the transparent S; only the
separate lightning layer moves.

![Animated Sideral icon](sideralLightning.gif)

| File | Purpose |
| --- | --- |
| [`sideralLightning.gif`](sideralLightning.gif) | 512 × 512 animation, 120 frames, 50 fps, 2.4-second infinite loop |
| [`sideralLightning.png`](sideralLightning.png) | 1024 × 1024 static Developer Portal export |
| [`sideralMark.png`](sideralMark.png) | Original transparent S foreground |
| [`generationPrompt.txt`](generationPrompt.txt) | Exact prompts and provenance |

## Use in Discord

The [presence extension](../../extensions/discord-presence/README.md) supplies this
public HTTPS URL as `assets.largeImage`:

```text
https://raw.githubusercontent.com/BRUN0R2/sideral-editor/main/assets/discord/sideralLightning.gif
```

Discord must fetch it anonymously. Publish assets to the public `main` branch;
never embed an access token in a presence URL. Rebuild/install the extension and
run **Discord: Refresh Discord Work Presence** after changing its artwork.

Discord fetches and animates the GIF; the editor does not send per-frame updates.
For a static application icon or uploaded Rich Presence asset, use the PNG.
The application icon and presence artwork are separate settings. See Discord's
[external asset documentation](https://docs.discord.com/developers/discord-social-sdk/development-guides/setting-rich-presence#uploading-assets).

## Rebuild exports

Use Node 24 or later and an isolated `sharp` authoring dependency:

```powershell
npm install --prefix build/artworkTools --no-save --ignore-scripts sharp@0.35.5
node scripts/buildDiscordArtwork.mjs build/artworkTools/node_modules/sharp
```

The [script](../../scripts/buildDiscordArtwork.mjs) replaces derived GIF/PNG files,
preserving the transparent foreground. Application and extension runtime do not
depend on image-processing tools.

Palette values come from [`base.css`](../../src/styles/base.css):
graphite `#282c34`/`#1e2228` and silver `#aeb4bd`/`#d0d3d8`. Composition orders
background, branching lightning, then the stationary S. Nearly opaque metal is
made opaque so it covers the electricity and glow.

The loop uses a 20 ms frame delay. Export validation checks dimensions, timing,
infinite looping, unchanged opaque foreground pixels and matching first/last
images after GIF decoding. Palette reuse and disabled dithering limit noise.
Framing, anchors, directions and glow parameters live in the script.
