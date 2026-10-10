import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageNames = new Set(["sideral-extension-sdk", "sideral-extension-testkit"]);
const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptsDirectory, "..");
const packageName = process.argv[2];

if (packageName === undefined || !packageNames.has(packageName)) {
  throw new Error(`Unknown repository SDK package: ${packageName ?? "<missing>"}`);
}

const sourceDirectory = resolve(projectDirectory, "packages", packageName);
const outputDirectory = resolve(projectDirectory, "build", "packages", packageName, "dist");
const typescriptCli = resolve(projectDirectory, "node_modules", "typescript", "bin", "tsc");

await rm(outputDirectory, { force: true, recursive: true });

const result = spawnSync(
  process.execPath,
  [
    typescriptCli,
    "--project",
    resolve(sourceDirectory, "tsconfig.json"),
    "--outDir",
    outputDirectory,
  ],
  { cwd: projectDirectory, stdio: "inherit" },
);

if (result.error !== undefined || result.status !== 0) {
  await rm(outputDirectory, { force: true, recursive: true });
  throw result.error ?? new Error(`TypeScript exited with code ${result.status}.`);
}

console.log(`Built ${packageName} in ${outputDirectory}.`);
