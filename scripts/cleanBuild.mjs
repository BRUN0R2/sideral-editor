import { rm } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const removalRetries = 3;
const retryDelayMilliseconds = 100;
const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptsDirectory, "..");
const buildDirectory = resolve(projectDirectory, "build");
const legacyOnly = process.argv.includes("--legacy-only");
const legacyDirectories = [
  resolve(projectDirectory, "dist"),
  resolve(projectDirectory, "target"),
  resolve(projectDirectory, "src-tauri", "target"),
  resolve(projectDirectory, "extensions", "amxx-pawn", "dist"),
  resolve(projectDirectory, "extensions", "discord-presence", "dist"),
  resolve(projectDirectory, "extensions", "markdown-preview", "dist"),
  resolve(projectDirectory, "packages", "sideral-extension-sdk", "dist"),
  resolve(projectDirectory, "packages", "sideral-extension-testkit", "dist"),
];

if (dirname(buildDirectory) !== projectDirectory || basename(buildDirectory) !== "build") {
  throw new Error(`Refusing to clean an unexpected directory: ${buildDirectory}`);
}

for (const directory of legacyOnly ? legacyDirectories : [buildDirectory, ...legacyDirectories]) {
  const relativeDirectory = relative(projectDirectory, directory);
  if (
    relativeDirectory.length === 0 ||
    relativeDirectory === ".." ||
    relativeDirectory.startsWith(`..${sep}`) ||
    !["build", "dist", "target"].includes(basename(directory))
  ) {
    throw new Error(`Refusing to clean an unexpected directory: ${directory}`);
  }

  await rm(directory, {
    force: true,
    maxRetries: removalRetries,
    recursive: true,
    retryDelay: retryDelayMilliseconds,
  });
}

console.log(
  legacyOnly
    ? "Removed legacy build artifacts outside the canonical build directory."
    : `Removed generated build artifacts from ${buildDirectory} and all legacy output paths.`,
);
