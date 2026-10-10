import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const projectDirectory = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@sideral/extension-sdk/protocol",
        replacement: resolve(projectDirectory, "packages/sideral-extension-sdk/src/protocol.ts"),
      },
      {
        find: "@sideral/extension-sdk",
        replacement: resolve(projectDirectory, "packages/sideral-extension-sdk/src/index.ts"),
      },
      {
        find: "@sideral/extension-testkit",
        replacement: resolve(projectDirectory, "packages/sideral-extension-testkit/src/index.ts"),
      },
    ],
  },
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["references/**", "node_modules/**"],
  },
});
