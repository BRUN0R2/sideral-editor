/// <reference types="node" />

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const { TAURI_DEV_HOST: developmentHost } = process.env;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
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
