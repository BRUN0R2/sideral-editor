import { readdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

const KILOBYTE = 1_000;
const assetsDirectory = resolve("build", "frontend", "assets");

const defaultBudget = {
  name: "application chunk",
  maxBytes: 500 * KILOBYTE,
};

const intentionalMonacoBudgets = [
  {
    name: "Monaco TypeScript worker",
    pattern: /(^|\/)ts\.worker-[^/]+\.js$/,
    maxBytes: 7_600 * KILOBYTE,
  },
  {
    name: "Monaco editor runtime",
    pattern: /(^|\/)editor\.api-[^/]+\.js$/,
    maxBytes: 2_950 * KILOBYTE,
  },
  {
    name: "lazy editor feature bundle",
    pattern: /(^|\/)EditorPane-[^/]+\.js$/,
    maxBytes: 1_400 * KILOBYTE,
  },
  {
    name: "Monaco CSS worker",
    pattern: /(^|\/)css\.worker-[^/]+\.js$/,
    maxBytes: 1_200 * KILOBYTE,
  },
  {
    name: "Monaco HTML worker",
    pattern: /(^|\/)html\.worker-[^/]+\.js$/,
    maxBytes: 850 * KILOBYTE,
  },
];

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? collectFiles(path) : [path];
    }),
  );
  return nestedFiles.flat();
}

function budgetFor(relativePath) {
  return (
    intentionalMonacoBudgets.find(({ pattern }) => pattern.test(relativePath)) ?? defaultBudget
  );
}

const javascriptAssets = (await collectFiles(assetsDirectory)).filter((path) =>
  path.endsWith(".js"),
);

if (javascriptAssets.length === 0) {
  throw new Error(`No JavaScript assets found in ${assetsDirectory}.`);
}

const measuredAssets = await Promise.all(
  javascriptAssets.map(async (path) => {
    const relativePath = relative(assetsDirectory, path).replaceAll("\\", "/");
    return {
      budget: budgetFor(relativePath),
      bytes: (await stat(path)).size,
      relativePath,
    };
  }),
);

const violations = measuredAssets.filter(({ budget, bytes }) => bytes > budget.maxBytes);

if (violations.length > 0) {
  const details = violations
    .sort((left, right) => right.bytes - left.bytes)
    .map(
      ({ budget, bytes, relativePath }) =>
        `- ${relativePath}: ${(bytes / KILOBYTE).toFixed(2)} kB exceeds ${(
          budget.maxBytes / KILOBYTE
        ).toFixed(0)} kB (${budget.name})`,
    )
    .join("\n");
  throw new Error(`Bundle size budget exceeded:\n${details}`);
}

const largestAsset = measuredAssets.reduce((largest, asset) =>
  asset.bytes > largest.bytes ? asset : largest,
);

console.log(
  `Bundle budgets passed for ${measuredAssets.length} JavaScript assets; largest is ${
    largestAsset.relativePath
  } at ${(largestAsset.bytes / KILOBYTE).toFixed(2)} kB.`,
);
