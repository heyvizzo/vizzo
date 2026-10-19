import { defineConfig } from "vite";
import { resolve } from "node:path";
import { themeCss } from "./shared/theme.ts";

export default defineConfig({
  root: "web",
  // The colours (shared/theme.ts) as the first thing in every page's <head>, so nothing paints before them.
  plugins: [{ name: "theme", transformIndexHtml: () => [{ tag: "style", attrs: { id: "theme" }, children: themeCss(), injectTo: "head-prepend" }] }],
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
