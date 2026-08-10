/// <reference types="node" />

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const { TAURI_DEV_HOST: developmentHost } = process.env;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  optimizeDeps: {
    entries: ["index.html"],
  },
  build: {
    // Monaco's language workers are intentionally lazy and have very different
    // size profiles. The post-build budget check keeps strict per-asset limits.
    chunkSizeWarningLimit: 7_600,
    rolldownOptions: {
      output: {
        codeSplitting: true,
      },
    },
  },
  server: {
    host: developmentHost ?? "127.0.0.1",
    port: 1420,
    strictPort: true,
    ...(developmentHost
      ? {
          hmr: {
            protocol: "ws" as const,
            host: developmentHost,
            port: 1421,
          },
        }
      : {}),
    watch: {
      ignored: ["**/src-tauri/**", "**/references/**"],
    },
  },
});
