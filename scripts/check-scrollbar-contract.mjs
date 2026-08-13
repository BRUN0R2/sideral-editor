import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repositoryRoot = process.cwd();
const sourceRoot = path.join(repositoryRoot, "src");
const canonicalStyles = path.join(sourceRoot, "styles", "scrollbars.css");
const monacoAdapterStyles = path.join(sourceRoot, "features", "editor", "monaco-scrollbar.css");
const requiredTokens = [
  "--sideral-scrollbar-track-size",
  "--sideral-scrollbar-thumb-size",
  "--sideral-scrollbar-track-color",
  "--sideral-scrollbar-thumb-color",
  "--sideral-scrollbar-thumb-hover-color",
  "--sideral-scrollbar-thumb-active-color",
  "--sideral-scrollbar-button-display",
  "--sideral-scrollbar-button-size",
  "--sideral-scrollbar-arrow-size",
  "--sideral-scrollbar-arrow-height",
  "--sideral-scrollbar-arrow-color",
  "--sideral-scrollbar-arrow-hover-color",
  "--sideral-scrollbar-arrow-active-color",
  "--sideral-scrollbar-arrow-up-shape",
  "--sideral-scrollbar-arrow-down-shape",
  "--sideral-scrollbar-corner-radius",
];
const failures = [];
const canonicalSource = fs.readFileSync(canonicalStyles, "utf8");

for (const token of requiredTokens) {
  if (!canonicalSource.includes(`${token}:`)) {
    failures.push(`Missing canonical scrollbar token: ${token}`);
  }
}

for (const file of sourceFiles(sourceRoot)) {
  const source = fs.readFileSync(file, "utf8");
  const relative = path.relative(repositoryRoot, file);
  if (source.includes("--scrollbar-")) {
    failures.push(`${relative} uses an unnamespaced legacy scrollbar token`);
  }
  if (file !== monacoAdapterStyles && source.includes(".monaco-scrollable-element > .scrollbar")) {
    failures.push(`${relative} reaches into Monaco scrollbar internals outside its adapter`);
  }
  if (
    !file.endsWith(".test.ts") &&
    /(?:horizontal|vertical)(?:Scrollbar|Slider)Size\s*:\s*\d/u.test(source)
  ) {
    failures.push(`${relative} hard-codes Monaco scrollbar geometry`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure);
  }
  process.exitCode = 1;
} else {
  console.log("Scrollbar contract boundary: ok");
}

function sourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(entryPath));
    } else if (/\.(?:css|ts|tsx)$/u.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}
