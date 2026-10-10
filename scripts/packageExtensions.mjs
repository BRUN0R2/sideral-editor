import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const extensionNames = ["amxx-pawn", "discord-presence", "markdown-preview"];
const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptsDirectory, "..");
const packagesDirectory = resolve(projectDirectory, "build", "extensions", "packages");
const temporaryPackagesDirectory = resolve(
  projectDirectory,
  "build",
  "extensions",
  `.packages-${process.pid}`,
);
const developmentMode = process.argv.includes("--development");

function runExtensionTool(arguments_) {
  const result = spawnSync(
    "cargo",
    [
      "run",
      "--quiet",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "-p",
      "sideral-extension-tool",
      "--",
      ...arguments_,
    ],
    { cwd: projectDirectory, stdio: "inherit" },
  );

  if (result.error !== undefined || result.status !== 0) {
    throw result.error ?? new Error(`The extension tool exited with code ${result.status}.`);
  }
}

async function resolveSigningKey() {
  if (developmentMode) {
    const localApplicationData = process.env.LOCALAPPDATA;
    if (localApplicationData === undefined || !isAbsolute(localApplicationData)) {
      throw new Error("LOCALAPPDATA must be an absolute path for development package signing.");
    }
    const keyPath = resolve(
      localApplicationData,
      "dev.sideral.editor",
      "development",
      "extension-signing-key.json",
    );
    try {
      await access(keyPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(dirname(keyPath), { recursive: true });
      runExtensionTool(["keygen", keyPath]);
    }
    return keyPath;
  }

  const configuredKeyPath = process.env.SIDERAL_EXTENSION_SIGNING_KEY;
  if (configuredKeyPath === undefined || !isAbsolute(configuredKeyPath)) {
    throw new Error("SIDERAL_EXTENSION_SIGNING_KEY must reference an absolute signing-key path.");
  }
  await access(configuredKeyPath);
  return configuredKeyPath;
}

if (!packagesDirectory.startsWith(`${resolve(projectDirectory, "build")}${sep}`)) {
  throw new Error(`Refusing to package into an unexpected directory: ${packagesDirectory}`);
}

const signingKeyPath = await resolveSigningKey();
await rm(temporaryPackagesDirectory, { force: true, recursive: true });
await mkdir(temporaryPackagesDirectory, { recursive: true });

try {
  for (const extensionName of extensionNames) {
    const stagedDirectory = resolve(projectDirectory, "build", "extensions", extensionName);
    const manifest = JSON.parse(await readFile(resolve(stagedDirectory, "manifest.json"), "utf8"));
    const packageName = `${manifest.id}-${manifest.version}`;
    if (!/^[a-z0-9.-]+$/u.test(packageName) || packageName.includes("..")) {
      throw new Error(`Extension ${extensionName} has an unsafe package identity.`);
    }
    const outputPath = resolve(temporaryPackagesDirectory, `${packageName}.sideralx`);
    if (!outputPath.startsWith(`${temporaryPackagesDirectory}${sep}`)) {
      throw new Error(`Extension ${extensionName} resolved outside the package directory.`);
    }
    runExtensionTool(["pack", stagedDirectory, signingKeyPath, outputPath]);
  }
  await rm(packagesDirectory, { force: true, recursive: true });
  await rename(temporaryPackagesDirectory, packagesDirectory);
} catch (error) {
  await rm(temporaryPackagesDirectory, { force: true, recursive: true });
  throw error;
}

console.log(`Created installable extension packages in ${packagesDirectory}.`);
