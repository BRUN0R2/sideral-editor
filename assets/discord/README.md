# Discord artwork

Silver S with white lightning on the editor's graphite palette, generated with
the built-in image generation tool and assembled into a continuous loop.

![Animated Sideral icon](sideralLightning.gif)

| File | Purpose |
| --- | --- |
| `sideralLightning.gif` | Rich Presence animation: 512 × 512, 40 frames, 20 fps, 2-second infinite loop |
| `sideralLightning.png` | Static 1024 × 1024 export for the Developer Portal |
| `sideralLightningFrames.png` | Original 1254 × 1254 source sheet, four keyframes in reading order |
| `generationPrompt.txt` | Exact generation prompts and provenance |

The palette comes from `src/styles/base.css`: graphite `#282c34`, dark graphite
`#1e2228`, silver `#aeb4bd` and pale silver `#d0d3d8`. Each 627-pixel source
tile is cropped by two pixels on each side to exclude grid seams. The GIF is
downsampled to 512 pixels; the PNG is resampled to 1024 pixels. Crossfades join
all four keyframes, including the last-to-first transition.

## Discord setup

The extension sets `assets.largeImage` to:

```text
https://raw.githubusercontent.com/BRUN0R2/sideral-editor/main/assets/discord/sideralLightning.gif
```

Publish these assets to `main` and make the repository public before expecting
Discord to show the image. The URL must return the GIF without authentication.
While the repository is private, no token or authenticated URL should be put
in the presence payload. The source configuration is in
`extensions/discord-presence/src/activity.ts`.

Build and install the updated Discord Work Presence extension, then run
**Discord: Refresh Discord Work Presence** in Sideral. The GIF is animated by
Discord and introduces no application animation timers or per-frame RPC calls.

For a static application icon, upload `sideralLightning.png` to the app's icon
field in the Discord Developer Portal. A Rich Presence art asset uploaded to
the portal is also static. Discord documents support for GIF animation through
[external asset URLs](https://docs.discord.com/developers/discord-social-sdk/development-guides/setting-rich-presence#uploading-assets).
The application icon and Rich Presence artwork are separate settings.

## Rebuild the exports

Use Node.js 24 or later and sharp 0.35.5 as an isolated authoring dependency;
neither the application nor the extension needs an image processing package.
From the repository root:

```powershell
npm install --prefix build/artworkTools --no-save --ignore-scripts sharp@0.35.5
node scripts/buildDiscordArtwork.mjs build/artworkTools/node_modules/sharp
```

The script keeps the source sheet unchanged and replaces the derived GIF and
PNG. Dimensions, frame count, duration and infinite looping are checked after
encoding. All timing and export choices are named in its `settings` object.
