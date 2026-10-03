import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// sharp is an isolated authoring tool, never an application dependency.
const require = createRequire(import.meta.url);
const sharp = require(process.argv[2] ? resolve(process.argv[2]) : "sharp");
const artworkDirectory = new URL("../assets/discord/", import.meta.url);
const artworkPath = (name) => fileURLToPath(new URL(name, artworkDirectory));
const settings = {
  animationSize: 512,
  posterSize: 1024,
  durationMs: 2400,
  frameDelayMs: 20,
  channels: 3,
  infiniteLoop: 0,
  paletteColors: 256,
  paletteReuseTolerance: 256,
  encoderEffort: 10,
  posterPhase: 0.19,
  foregroundSizeRatio: 0.74,
  foregroundOffsetY: -0.022,
  opaqueAlphaThreshold: 245,
  clearAlphaThreshold: 8,
};
const lightning = {
  coordinateSize: 1024,
  // Anchors sit inside the two opaque metal terminals, behind the foreground.
  tips: [
    { x: 0.716, y: 0.276 },
    { x: 0.295, y: 0.668 },
  ],
  rays: [
    { tip: 0, angleTurns: -0.26 },
    { tip: 0, angleTurns: -0.12 },
    { tip: 0, angleTurns: 0.01 },
    { tip: 0, angleTurns: 0.12 },
    { tip: 1, angleTurns: 0.26 },
    { tip: 1, angleTurns: 0.38 },
    { tip: 1, angleTurns: 0.49 },
    { tip: 1, angleTurns: 0.62 },
  ],
  segments: 48,
  pulsesPerLoop: 2,
  growthFraction: 0.68,
  angleSway: 0.045,
  edgeOvershoot: 1.06,
  jitter: 0.012,
  fineJitter: 0.003,
  branchInterval: 7,
  branchSegments: 10,
  branchLength: 0.095,
  branchSpread: 0.42,
  glowWidth: 8,
  glowBlur: 5,
  bloomWidth: 3,
  bloomBlur: 1.2,
  coreWidth: 1.2,
  forkWidth: 0.7,
  deterministicSeed: 37,
};
const fullTurn = Math.PI * 2;
const frameCount = settings.durationMs / settings.frameDelayMs;
if (!Number.isInteger(frameCount)) {
  throw new Error("The animation duration must be divisible by the frame delay.");
}

// All noise is periodic in phase. No frame has an independently generated S.
function wave(index, phase, frequency) {
  const spatialNoise = Math.sin(index * lightning.deterministicSeed) * lightning.deterministicSeed;
  return Math.sin(spatialNoise + phase * fullTurn * frequency);
}

function pointAt(ray, progress, phase) {
  const direction = lightning.rays[ray];
  const origin = lightning.tips[direction.tip];
  const angle = direction.angleTurns * fullTurn + lightning.angleSway * wave(ray, phase, 1);
  const directionX = Math.cos(angle);
  const directionY = Math.sin(angle);
  const toEdgeX = ((directionX >= 0 ? 1 : 0) - origin.x) / directionX;
  const toEdgeY = ((directionY >= 0 ? 1 : 0) - origin.y) / directionY;
  const length = Math.min(toEdgeX, toEdgeY) * lightning.edgeOvershoot;
  const segment = progress * lightning.segments;
  const offset =
    Math.sin(progress * Math.PI) *
    (lightning.jitter * wave(segment + ray, phase, 3) +
      lightning.fineJitter * wave(segment * 2 + ray, phase, 5));
  return {
    x: origin.x + directionX * length * progress - directionY * offset,
    y: origin.y + directionY * length * progress + directionX * offset,
    angle,
  };
}

function pathData(points) {
  return points
    .map(
      ({ x, y }, index) =>
        `${index === 0 ? "M" : "L"}${(x * lightning.coordinateSize).toFixed(2)},${(y * lightning.coordinateSize).toFixed(2)}`,
    )
    .join(" ");
}

function rayPaths(ray, phase) {
  const pulse = (phase * lightning.pulsesPerLoop + ray / lightning.rays.length) % 1;
  const extent = Math.min(1, pulse / lightning.growthFraction);
  const opacity = Math.sin(pulse * Math.PI) ** 0.8;
  const points = [];
  const forks = [];
  for (let segment = 0; segment <= lightning.segments; segment += 1) {
    const progress = Math.min(segment / lightning.segments, extent);
    const point = pointAt(ray, progress, phase);
    points.push(point);
    if (segment > 0 && segment % lightning.branchInterval === 0 && progress < extent) {
      const branch = [point];
      const side = segment % (lightning.branchInterval * 2) === 0 ? 1 : -1;
      const branchAngle = point.angle + side * lightning.branchSpread;
      const length = Math.min(lightning.branchLength, (extent - progress) * 0.5);
      for (let step = 1; step <= lightning.branchSegments; step += 1) {
        const fraction = step / lightning.branchSegments;
        const offset = lightning.fineJitter * wave(segment + step + ray, phase, 3);
        branch.push({
          x: point.x + Math.cos(branchAngle) * length * fraction - Math.sin(branchAngle) * offset,
          y: point.y + Math.sin(branchAngle) * length * fraction + Math.cos(branchAngle) * offset,
        });
      }
      forks.push(pathData(branch));
    }
    if (progress === extent) break;
  }
  return { core: pathData(points), forks: forks.join(" "), opacity: opacity.toFixed(3) };
}

function lightningSvg(phase, size) {
  const rays = lightning.rays.map((_, ray) => rayPaths(ray, phase));
  const paths = (kind, width) =>
    rays
      .map((ray) => `<path d="${ray[kind]}" opacity="${ray.opacity}" stroke-width="${width}"/>`)
      .join("");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${lightning.coordinateSize} ${lightning.coordinateSize}">
    <defs>
      <filter id="glow" x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="${lightning.glowBlur}"/></filter>
      <filter id="bloom" x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="${lightning.bloomBlur}"/></filter>
    </defs>
    <g fill="none" stroke-linecap="round" stroke-linejoin="round">
      <g stroke="#d0d3d8" opacity="0.32" filter="url(#glow)">${paths("core", lightning.glowWidth)}</g>
      <g stroke="#e8e9ec" opacity="0.65" filter="url(#bloom)">${paths("core", lightning.bloomWidth)}${paths("forks", lightning.forkWidth)}</g>
      <g stroke="#fafafa">${paths("core", lightning.coreWidth)}${paths("forks", lightning.forkWidth)}</g>
    </g>
  </svg>`);
}

const source = sharp(artworkPath("sideralMark.png"));
const sourceMetadata = await source.metadata();
if (!sourceMetadata.hasAlpha || sourceMetadata.width !== sourceMetadata.height) {
  throw new Error("Expected a square S cutout with real alpha transparency.");
}
// Normalize the generated matte's nearly opaque metal and nearly clear backdrop.
// Otherwise an alpha of 253/255 would let lightning bleed through the letter.
const { data: cutoutPixels, info: cutoutInfo } = await source
  .raw()
  .toBuffer({ resolveWithObject: true });
const alphaChannel = cutoutInfo.channels - 1;
for (let index = alphaChannel; index < cutoutPixels.length; index += cutoutInfo.channels) {
  if (cutoutPixels[index] >= settings.opaqueAlphaThreshold) cutoutPixels[index] = 255;
  else if (cutoutPixels[index] <= settings.clearAlphaThreshold) cutoutPixels[index] = 0;
}
const master = sharp(cutoutPixels, {
  raw: { width: cutoutInfo.width, height: cutoutInfo.height, channels: cutoutInfo.channels },
});

function backgroundSvg(size) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <defs><radialGradient id="graphite"><stop stop-color="#373c45"/><stop offset="1" stop-color="#1e2228"/></radialGradient></defs>
    <rect width="100%" height="100%" fill="url(#graphite)"/>
  </svg>`);
}

async function createForeground(size) {
  const markSize = Math.round(size * settings.foregroundSizeRatio);
  const left = Math.round((size - markSize) / 2);
  const top = Math.round((size - markSize) / 2 + size * settings.foregroundOffsetY);
  return master
    .clone()
    .resize(markSize, markSize)
    .extend({
      left,
      right: size - markSize - left,
      top,
      bottom: size - markSize - top,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
}

// Cache both still layers. Only the middle layer changes from frame to frame.
const stationaryForeground = await createForeground(settings.animationSize);
const stationaryBackground = await sharp(backgroundSvg(settings.animationSize)).png().toBuffer();
const foregroundAlpha = await sharp(stationaryForeground).extractChannel("alpha").raw().toBuffer();
const opaquePixels = [];
for (let pixel = 0; pixel < foregroundAlpha.length; pixel += 1) {
  if (foregroundAlpha[pixel] === 255) opaquePixels.push(pixel * settings.channels);
}
const rawFrame = {
  width: settings.animationSize,
  height: settings.animationSize,
  channels: settings.channels,
};
async function renderFrame(phase) {
  return sharp(stationaryBackground)
    .composite([
      { input: lightningSvg(phase, settings.animationSize) },
      { input: stationaryForeground },
    ])
    .removeAlpha()
    .raw()
    .toBuffer();
}

const firstFrame = await renderFrame(0);
const closingFrame = await renderFrame(1);
if (!firstFrame.equals(closingFrame)) {
  throw new Error("The lightning motion does not close seamlessly.");
}
const frames = [firstFrame];
for (let index = 1; index < frameCount; index += 1) {
  const frame = await renderFrame(index / frameCount);
  for (const offset of opaquePixels) {
    for (let channel = 0; channel < settings.channels; channel += 1) {
      if (frame[offset + channel] !== firstFrame[offset + channel]) {
        throw new Error("Lightning changed a pixel of the opaque S foreground.");
      }
    }
  }
  frames.push(frame);
}

await sharp(backgroundSvg(settings.posterSize))
  .composite([
    { input: lightningSvg(settings.posterPhase, settings.posterSize) },
    { input: await createForeground(settings.posterSize) },
  ])
  .png()
  .toFile(artworkPath("sideralLightning.png"));

const gifPath = artworkPath("sideralLightning.gif");
await sharp(Buffer.concat(frames), {
  raw: {
    ...rawFrame,
    height: settings.animationSize * frameCount,
    pageHeight: settings.animationSize,
  },
})
  .gif({
    loop: settings.infiniteLoop,
    delay: frames.map(() => settings.frameDelayMs),
    colours: settings.paletteColors,
    effort: settings.encoderEffort,
    dither: 0,
    interPaletteMaxError: settings.paletteReuseTolerance,
  })
  .toFile(gifPath);

const result = await sharp(gifPath, { animated: true }).metadata();
const durationMs = result.delay?.reduce((total, delay) => total + delay, 0);
if (
  result.width !== settings.animationSize ||
  result.pageHeight !== settings.animationSize ||
  result.pages !== frameCount ||
  result.loop !== settings.infiniteLoop ||
  durationMs !== settings.durationMs ||
  !result.delay.every((delay) => delay === settings.frameDelayMs)
) {
  throw new Error("The exported GIF does not match its dimensions or loop timing.");
}
// Check the encoded file too: palette changes must not make the metal shimmer.
const decodedFrames = await sharp(gifPath, { animated: true }).removeAlpha().raw().toBuffer();
const frameBytes = settings.animationSize * settings.animationSize * settings.channels;
for (let frame = 1; frame < frameCount; frame += 1) {
  for (const offset of opaquePixels) {
    for (let channel = 0; channel < settings.channels; channel += 1) {
      if (
        decodedFrames[frame * frameBytes + offset + channel] !== decodedFrames[offset + channel]
      ) {
        throw new Error("GIF quantization changed a pixel of the stationary metal.");
      }
    }
  }
}
console.log(
  `${gifPath}: ${result.width}px, ${result.pages} frames, ${durationMs}ms, ${opaquePixels.length} protected foreground pixels.`,
);
