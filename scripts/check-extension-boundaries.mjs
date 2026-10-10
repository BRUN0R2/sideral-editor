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
  "src-tauri/src/extension_systems.rs",
  "src-tauri/crates/vscode-legacy-core",
  "src/features/vscode-legacy",
];

const rules = [
  {
    roots: modernRoots,
    forbidden: [
      { pattern: /\bvscode\b|vscode-/iu, reason: "legacy product coupling" },
      { pattern: /\blegacy\b/iu, reason: "legacy-system coupling" },
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
const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
if (
  !rootPackage.workspaces.includes("extensions/*") ||
  rootPackage.workspaces.some((workspace) => workspace.startsWith("examples/"))
) {
  violations.push("package.json: extension projects must share the extensions/* workspace");
}
if (/extensions:check|extension:[^ ]+:check/u.test(rootPackage.scripts.build)) {
  violations.push("package.json: release builds compile extensions but keep their tests explicit");
}
if (rootPackage.dependencies.marked !== undefined) {
  violations.push("package.json: the Markdown parser belongs to its extension");
}
const implementations = ["extensions", "examples"].map((root) => path.join(repositoryRoot, root));
function isInside(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function imports(source) {
  return [...source.matchAll(/(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/gu)].map(
    (match) => match[1],
  );
}
for (const file of await collectTextFiles("src")) {
  if (!/\.tsx?$/u.test(file)) continue;
  const source = await readFile(path.join(repositoryRoot, file), "utf8");
  if (
    imports(source).some((specifier) => {
      const target = path.resolve(repositoryRoot, path.dirname(file), specifier);
      return (
        specifier === "marked" ||
        (specifier.startsWith(".") && implementations.some((root) => isInside(root, target)))
      );
    })
  ) {
    violations.push(
      `${file}: application code cannot import an extension implementation or Markdown parser`,
    );
  }
}
for (const entry of await readdir(path.join(repositoryRoot, "extensions"), {
  withFileTypes: true,
})) {
  if (!entry.isDirectory()) continue;
  const extensionRoot = path.join("extensions", entry.name);
  const extensionPackage = JSON.parse(
    await readFile(path.join(repositoryRoot, extensionRoot, "package.json"), "utf8"),
  );
  await access(path.join(repositoryRoot, extensionRoot, "manifest.json"));
  try {
    await access(path.join(repositoryRoot, extensionRoot, "package-lock.json"));
    violations.push(`${extensionRoot}: repository extensions must use the shared root lockfile`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const file of await collectTextFiles(extensionRoot)) {
    if (!/\.tsx?$/u.test(file)) continue;
    const source = await readFile(path.join(repositoryRoot, file), "utf8");
    if (
      imports(source).some((specifier) => {
        const target = path.resolve(repositoryRoot, path.dirname(file), specifier);
        return (
          specifier.startsWith("@tauri-apps/") ||
          (specifier.startsWith(".") && !isInside(path.join(repositoryRoot, extensionRoot), target))
        );
      })
    ) {
      violations.push(
        `${file}: extensions can use the public SDK, not application modules or native IPC`,
      );
    }
  }
  const dependencies = { ...extensionPackage.dependencies, ...extensionPackage.devDependencies };
  for (const [name, version] of Object.entries(dependencies)) {
    if (
      version.startsWith("file:") &&
      !["@sideral/extension-sdk", "@sideral/extension-testkit"].includes(name)
    ) {
      violations.push(`${extensionRoot}/package.json: unsupported local implementation dependency`);
    }
  }
}
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
  process.stdout.write("The native extension boundary is isolated.\n");
}
