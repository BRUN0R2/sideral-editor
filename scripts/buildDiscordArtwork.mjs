import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The image encoder is an authoring tool, never an application dependency.
const require = createRequire(import.meta.url);
const sharp = require(process.argv[2] ? resolve(process.argv[2]) : "sharp");
const artworkDirectory = new URL("../assets/discord/", import.meta.url);
const sourcePath = fileURLToPath(new URL("sideralLightningFrames.png", artworkDirectory));
const settings = {
  columns: 2,
  rows: 2,
  tileInset: 2,
  animationSize: 512,
  posterSize: 1024,
  transitionFrames: 10,
  frameDelayMs: 50,
  channels: 3,
  paletteColors: 256,
  dither: 0.2,
  encoderEffort: 10,
  infiniteLoop: 0,
};

const metadata = await sharp(sourcePath).metadata();
if (
  !metadata.width ||
  metadata.width !== metadata.height ||
  metadata.width % settings.columns !== 0
) {
  throw new Error("Expected a square 2 by 2 source sheet with equally sized tiles.");
}

const tileSize = metadata.width / settings.columns;
const tileCount = settings.columns * settings.rows;
const keyframes = [];
for (let index = 0; index < tileCount; index += 1) {
  const region = {
    left: (index % settings.columns) * tileSize + settings.tileInset,
    top: Math.floor(index / settings.columns) * tileSize + settings.tileInset,
    width: tileSize - settings.tileInset * 2,
    height: tileSize - settings.tileInset * 2,
  };
  const tile = sharp(sourcePath).extract(region);
  if (index === 0) {
    await tile
      .clone()
      .resize(settings.posterSize, settings.posterSize)
      .png()
      .toFile(fileURLToPath(new URL("sideralLightning.png", artworkDirectory)));
  }
  keyframes.push(
    await tile
      .resize(settings.animationSize, settings.animationSize)
      .removeAlpha()
      .raw()
      .toBuffer(),
  );
}

// Smooth transitions include the last-to-first pair so playback loops continuously.
const frames = [];
for (let index = 0; index < tileCount; index += 1) {
  const current = keyframes[index];
  const next = keyframes[(index + 1) % tileCount];
  for (let step = 0; step < settings.transitionFrames; step += 1) {
    const progress = step / settings.transitionFrames;
    const blend = (1 - Math.cos(progress * Math.PI)) / 2;
    const frame = Buffer.alloc(current.length);
    for (let channel = 0; channel < current.length; channel += 1) {
      frame[channel] = Math.round(current[channel] * (1 - blend) + next[channel] * blend);
    }
    frames.push(frame);
  }
}

const gifPath = fileURLToPath(new URL("sideralLightning.gif", artworkDirectory));
await sharp(Buffer.concat(frames), {
  raw: {
    width: settings.animationSize,
    height: settings.animationSize * frames.length,
    channels: settings.channels,
    pageHeight: settings.animationSize,
  },
})
  .gif({
    loop: settings.infiniteLoop,
    delay: frames.map(() => settings.frameDelayMs),
    colours: settings.paletteColors,
    effort: settings.encoderEffort,
    dither: settings.dither,
    interPaletteMaxError: 0,
  })
  .toFile(gifPath);

const result = await sharp(gifPath, { animated: true }).metadata();
const expectedDurationMs = frames.length * settings.frameDelayMs;
const durationMs = result.delay?.reduce((total, delay) => total + delay, 0);
if (
  result.width !== settings.animationSize ||
  result.pageHeight !== settings.animationSize ||
  result.pages !== frames.length ||
  result.loop !== settings.infiniteLoop ||
  durationMs !== expectedDurationMs
) {
  throw new Error("The exported GIF does not match the expected dimensions or loop timing.");
}
console.log(
  `${gifPath}: ${result.width}px, ${result.pages} frames, ${durationMs}ms, infinite loop.`,
);
