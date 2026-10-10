import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const documentationFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "*.md"],
  { cwd: projectDirectory, encoding: "utf8", windowsHide: true },
)
  .split("\0")
  .filter(Boolean);
const documents = new Map();

function proseLines(source) {
  let fence = null;
  return source.split(/\r?\n/u).map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (fence !== null) {
      if (
        marker !== null &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        marker[2].trim() === ""
      ) {
        fence = null;
      }
      return "";
    }
    if (marker !== null) {
      fence = marker[1];
      return "";
    }
    return line;
  });
}

async function readDocument(path) {
  if (documents.has(path)) return documents.get(path);
  const lines = proseLines(await readFile(path, "utf8"));
  const anchors = new Set();
  const occurrences = new Map();
  for (const line of lines) {
    const heading = line.match(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/u);
    if (heading === null) continue;
    const slug = heading[1]
      .replace(/<[^>]*>/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\-\s]/gu, "")
      .replace(/\s/gu, "-");
    const count = occurrences.get(slug) ?? 0;
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
    occurrences.set(slug, count + 1);
  }
  const document = { lines, anchors };
  documents.set(path, document);
  return document;
}

const errors = [];
let checkedLinks = 0;
for (const file of documentationFiles) {
  const path = resolve(projectDirectory, file);
  const { lines } = await readDocument(path);
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/gu)) {
      const target = match[1].trim().replace(/^<(.+)>$/u, "$1");
      if (/^[a-z][a-z\d+.-]*:/iu.test(target)) continue;
      checkedLinks += 1;
      try {
        const [fileTarget, fragment] = target.split("#", 2);
        const targetPath =
          fileTarget === "" ? path : resolve(dirname(path), decodeURIComponent(fileTarget));
        const targetRelative = relative(projectDirectory, targetPath);
        if (
          targetRelative === ".." ||
          targetRelative.startsWith(`..${sep}`) ||
          isAbsolute(targetRelative)
        ) {
          throw new Error("target escapes the repository");
        }
        const targetInfo = await stat(targetPath);
        if (
          fragment !== undefined &&
          fragment !== "" &&
          targetInfo.isFile() &&
          /\.md$/iu.test(targetPath)
        ) {
          const document = await readDocument(targetPath);
          if (!document.anchors.has(decodeURIComponent(fragment))) {
            throw new Error(`heading #${fragment} does not exist`);
          }
        }
      } catch (error) {
        errors.push(`${file}:${index + 1}: ${target}: ${error.message}`);
      }
    }
  }
}

if (errors.length > 0) throw new Error(`Documentation links failed:\n${errors.join("\n")}`);
console.log(
  `Checked ${checkedLinks} local links in ${documentationFiles.length} Markdown documents.`,
);
