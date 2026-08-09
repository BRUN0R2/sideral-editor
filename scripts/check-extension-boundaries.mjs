import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repositoryRoot = process.cwd();
const modernRoots = [
  "src-tauri/crates/sideral-extension-core",
  "src/features/sideral-extensions",
  "packages/sideral-extension-sdk",
];
const legacyRoots = ["src-tauri/crates/vscode-legacy-core", "src/features/vscode-legacy"];
const textExtensions = new Set([".json", ".md", ".mjs", ".rs", ".toml", ".ts"]);

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
        pattern: /sideral[-_]extension[-_]core/iu,
        reason: "modern native-core dependency",
      },
      {
        pattern: /features[/\\]sideral-extensions/iu,
        reason: "modern frontend dependency",
      },
      { pattern: /@sideral\/extension-sdk/iu, reason: "modern SDK dependency" },
    ],
  },
];

async function collectTextFiles(relativeRoot) {
  const absoluteRoot = path.join(repositoryRoot, relativeRoot);
  const entries = await readdir(absoluteRoot, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "dist") {
        files.push(...(await collectTextFiles(relativePath)));
      }
      continue;
    }
    if (entry.isFile() && textExtensions.has(path.extname(entry.name))) {
      files.push(relativePath);
    }
  }

  return files;
}

const violations = [];
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

if (violations.length > 0) {
  process.stderr.write(`Extension boundary violations:\n${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Extension boundaries are isolated.\n");
}
