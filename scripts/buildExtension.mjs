import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const extensionNames = new Set(["amxx-pawn", "discord-presence", "markdown-preview"]);
const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptsDirectory, "..");
const extensionName = process.argv[2];

if (extensionName === undefined || !extensionNames.has(extensionName)) {
  throw new Error(`Unknown repository extension: ${extensionName ?? "<missing>"}`);
}

const sourceDirectory = resolve(projectDirectory, "extensions", extensionName);
const outputDirectory = resolve(projectDirectory, "build", "extensions", extensionName);
const manifest = JSON.parse(await readFile(resolve(sourceDirectory, "manifest.json"), "utf8"));
const packageManifest = JSON.parse(
  await readFile(resolve(sourceDirectory, "package.json"), "utf8"),
);
const runtimeEntry = manifest.runtime?.entry;

if (manifest.id !== packageManifest.name || manifest.version !== packageManifest.version) {
  throw new Error(
    `Extension ${extensionName} must use the same identity and version in manifest.json and package.json.`,
  );
}

if (typeof runtimeEntry !== "string") {
  throw new Error(`Extension ${extensionName} does not declare a runtime entry.`);
}

const outputEntry = resolve(outputDirectory, runtimeEntry);
if (!outputEntry.startsWith(`${outputDirectory}${sep}`)) {
  throw new Error(`Extension ${extensionName} has an unsafe runtime entry: ${runtimeEntry}`);
}

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(dirname(outputEntry), { recursive: true });

const rolldownCli = resolve(projectDirectory, "node_modules", "rolldown", "bin", "cli.mjs");
const result = spawnSync(
  process.execPath,
  [
    rolldownCli,
    resolve(sourceDirectory, "src", "extension.ts"),
    "--file",
    outputEntry,
    "--format",
    "esm",
    "--platform",
    "browser",
    "--transform.target",
    "es2024",
    "--minify",
  ],
  { cwd: projectDirectory, stdio: "inherit" },
);

if (result.error !== undefined || result.status !== 0) {
  await rm(outputDirectory, { force: true, recursive: true });
  throw result.error ?? new Error(`Rolldown exited with code ${result.status}.`);
}

await cp(resolve(sourceDirectory, "manifest.json"), resolve(outputDirectory, "manifest.json"));
await cp(resolve(sourceDirectory, "assets"), resolve(outputDirectory, "assets"), {
  errorOnExist: false,
  force: true,
  recursive: true,
}).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});

console.log(`Built ${manifest.id} in ${outputDirectory}.`);
