import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "vite";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptsDirectory, "..");
const buildDirectory = resolve(projectDirectory, "build");
const expectedCargoDirectory = resolve(buildDirectory, "cargo");
const expectedFrontendDirectory = resolve(buildDirectory, "frontend");

function assertEqual(actual, expected, description) {
  if (actual !== expected) {
    throw new Error(`${description} must be ${expected}, received ${actual}.`);
  }
}

const cargoMetadata = JSON.parse(
  execFileSync(
    "cargo",
    ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", "src-tauri/Cargo.toml"],
    { cwd: projectDirectory, encoding: "utf8" },
  ),
);
assertEqual(
  resolve(cargoMetadata.target_directory),
  expectedCargoDirectory,
  "Cargo target directory",
);

const tauriConfiguration = JSON.parse(
  await readFile(resolve(projectDirectory, "src-tauri", "tauri.conf.json"), "utf8"),
);
assertEqual(
  tauriConfiguration.build?.frontendDist,
  "../build/frontend",
  "Tauri frontend directory",
);
assertEqual(tauriConfiguration.build?.beforeBuildCommand, "npm run build", "Tauri build command");

const viteConfiguration = await resolveConfig(
  { configFile: resolve(projectDirectory, "vite.config.ts") },
  "build",
);
assertEqual(
  resolve(viteConfiguration.build.outDir),
  expectedFrontendDirectory,
  "Vite output directory",
);

const packageManifest = JSON.parse(
  await readFile(resolve(projectDirectory, "package.json"), "utf8"),
);
const buildSteps = packageManifest.scripts?.build?.split(" && ") ?? [];
for (const requiredStep of [
  "npm run typecheck",
  "npm run sdk:build",
  "npm run extensions:build",
  "npm run frontend:bundle",
]) {
  if (!buildSteps.includes(requiredStep)) {
    throw new Error(`The main build must include: ${requiredStep}.`);
  }
}

for (const [scriptName, expectedCommand] of Object.entries({
  "extensions:package": "npm run extensions:build && node scripts/packageExtensions.mjs",
  "extensions:package:dev":
    "npm run extensions:build && node scripts/packageExtensions.mjs --development",
  "release:local": "npm run tauri build && npm run extensions:package:dev",
  "sdk:build":
    "npm run build --workspace @sideral/extension-sdk && npm run build --workspace @sideral/extension-testkit",
})) {
  assertEqual(packageManifest.scripts?.[scriptName], expectedCommand, `npm script ${scriptName}`);
}

for (const [manifestPath, expectedCommand] of [
  [
    "packages/sideral-extension-sdk/package.json",
    "node ../../scripts/buildSdkPackage.mjs sideral-extension-sdk",
  ],
  [
    "packages/sideral-extension-testkit/package.json",
    "node ../../scripts/buildSdkPackage.mjs sideral-extension-testkit",
  ],
  ["extensions/amxx-pawn/package.json", "node ../../scripts/buildExtension.mjs amxx-pawn"],
  [
    "extensions/discord-presence/package.json",
    "node ../../scripts/buildExtension.mjs discord-presence",
  ],
  [
    "extensions/markdown-preview/package.json",
    "node ../../scripts/buildExtension.mjs markdown-preview",
  ],
]) {
  const workspaceManifest = JSON.parse(
    await readFile(resolve(projectDirectory, manifestPath), "utf8"),
  );
  assertEqual(workspaceManifest.scripts?.build, expectedCommand, `${manifestPath} build command`);
}

for (const forbiddenDirectory of [
  "dist",
  "target",
  "src-tauri/target",
  "extensions/amxx-pawn/dist",
  "extensions/discord-presence/dist",
  "extensions/markdown-preview/dist",
  "packages/sideral-extension-sdk/dist",
  "packages/sideral-extension-testkit/dist",
]) {
  try {
    const entries = await readdir(resolve(projectDirectory, forbiddenDirectory));
    if (entries.length > 0) {
      throw new Error(
        `${forbiddenDirectory} contains generated output; all project builds belong under build/.`,
      );
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

console.log(
  `Build layout is canonical: Cargo uses ${expectedCargoDirectory} and Vite uses ${expectedFrontendDirectory}.`,
);
