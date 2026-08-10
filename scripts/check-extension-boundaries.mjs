import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repositoryRoot = process.cwd();
const modernRoots = [
  "src-tauri/crates/sideral-extension-core",
  "src-tauri/crates/sideral-extension-package",
  "src-tauri/crates/sideral-extension-tool",
  "src-tauri/src/sideral_extensions",
  "src/features/sideral-extensions",
  "packages/sideral-extension-sdk",
  "packages/sideral-extension-testkit",
];
const legacyRoots = ["src-tauri/crates/vscode-legacy-core", "src/features/vscode-legacy"];
const textExtensions = new Set([
  ".css",
  ".html",
  ".json",
  ".md",
  ".mjs",
  ".rs",
  ".toml",
  ".ts",
  ".tsx",
]);
const ignoredDirectories = new Set(["dist", "node_modules", "target"]);
const retiredHostArtifacts = [
  "extension-host.html",
  "src/extension-host.ts",
  "src-tauri/capabilities/extension-host.json",
];

const rules = [
  {
    roots: modernRoots,
    forbidden: [
      { pattern: /\bvscode\b|vscode-/iu, reason: "legacy product coupling" },
      { pattern: /\blegacy\b/iu, reason: "legacy-system coupling" },
    ],
  },
  {
    roots: legacyRoots,
    forbidden: [
      {
        pattern: /sideral[-_]extension[-_](?:core|package|tool)/iu,
        reason: "modern native dependency",
      },
      {
        pattern: /features[/\\]sideral-extensions/iu,
        reason: "modern frontend dependency",
      },
      { pattern: /@sideral\/extension-/iu, reason: "modern SDK dependency" },
    ],
  },
];

async function collectTextFiles(relativeRoot) {
  const entries = await readdir(path.join(repositoryRoot, relativeRoot), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...(await collectTextFiles(relativePath)));
      }
    } else if (entry.isFile() && textExtensions.has(path.extname(entry.name))) {
      files.push(relativePath);
    }
  }
  return files;
}

const violations = [];
for (const artifact of retiredHostArtifacts) {
  try {
    await access(path.join(repositoryRoot, artifact));
    violations.push(`${artifact}: retired hidden-host artifact`);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

for (const rule of rules) {
  for (const root of rule.roots) {
    for (const file of await collectTextFiles(root)) {
      const source = await readFile(path.join(repositoryRoot, file), "utf8");
      for (const forbidden of rule.forbidden) {
        if (forbidden.pattern.test(source)) {
          violations.push(`${file}: ${forbidden.reason}`);
        }
      }
    }
  }
}

const workerSource = await readFile(
  path.join(repositoryRoot, "src/features/sideral-extensions/host/worker-entry.ts"),
  "utf8",
);
if (/@tauri-apps|\binvoke\s*\(/u.test(workerSource)) {
  violations.push(
    "src/features/sideral-extensions/host/worker-entry.ts: worker cannot access native IPC",
  );
}

const serviceSource = await readFile(
  path.join(repositoryRoot, "src-tauri/src/sideral_extensions/service.rs"),
  "utf8",
);
if (
  /WebviewWindowBuilder|WebviewUrl::App|HOST_CONNECT_DEADLINE|ensure_host_connected|host_signal/u.test(
    serviceSource,
  )
) {
  violations.push(
    "src-tauri/src/sideral_extensions/service.rs: extension startup must use an explicit main-document session",
  );
}

const hostConnectionSource = await readFile(
  path.join(repositoryRoot, "src/features/sideral-extensions/host/connection.ts"),
  "utf8",
);
if (/setTimeout|setInterval|\bsleep\b/u.test(hostConnectionSource)) {
  violations.push(
    "src/features/sideral-extensions/host/connection.ts: startup coordination cannot use timers or polling",
  );
}

const devPortSource = await readFile(
  path.join(repositoryRoot, "scripts/prepare-dev-port.ps1"),
  "utf8",
);
if (/Start-Sleep/iu.test(devPortSource)) {
  violations.push(
    "scripts/prepare-dev-port.ps1: process cleanup must wait on process state instead of polling",
  );
}

if (violations.length > 0) {
  process.stderr.write(`Extension boundary violations:\n${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Extension boundaries are isolated.\n");
}
