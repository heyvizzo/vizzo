import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: "web",
  server: {
    port: 5173,
    proxy: {
      // Regex key: a plain "/ws" prefix would also proxy the web/ws.ts module itself and break every page in dev.
      "^/ws$": { target: "ws://localhost:8787", ws: true },
      "/api": { target: "http://localhost:8787" },
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "web/index.html"),
        cursor: resolve(import.meta.dirname, "web/cursor.html"),
        audioTest: resolve(import.meta.dirname, "web/audio-test.html"),
      },
    },
  },
});
