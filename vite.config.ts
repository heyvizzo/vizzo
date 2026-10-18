import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: "web",
  server: {
    port: 5173,
    proxy: {
      // Regex key: a plain "/ws" prefix would also proxy the web/ws.ts module itself and break every page in dev.
      // PORT: the voice server's port (the Electron app picks a free one); 8787 by default.
      "^/ws$": { target: `ws://127.0.0.1:${process.env.PORT ?? 8787}`, ws: true },
      "/api": { target: `http://127.0.0.1:${process.env.PORT ?? 8787}` },
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        chat: resolve(import.meta.dirname, "web/chat.html"),
        settings: resolve(import.meta.dirname, "web/settings.html"),
      },
    },
  },
});
