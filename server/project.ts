// The project the browser pane shows and the solver works on: a folder outside this repo, given at server start
// (PROJECT_DIR=/path/to/project npm run dev). Set once; everything reads it through projectDir().
import { readFile } from "node:fs/promises";
import { statSync, watch } from "node:fs";
import { join, resolve } from "node:path";

let dir: string | null = null;

/** Set the project folder (or clear it with null). Throws if the path isn't an existing folder. */
export function setProjectDir(path: string | null | undefined): void {
  if (!path) { dir = null; return; }
  const abs = resolve(path);
  if (!statSync(abs, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`PROJECT_DIR is not a folder: ${abs}`);
  dir = abs;
}

export function projectDir(): string | null { return dir; }

/** The demo page's own files: the only project files the browser may load. */
export const DEMO_FILES = ["demo.html", "demo.css", "demo.ts"] as const;

/** Files given to the solver inline on the API backend (the CLI backend reads the folder itself). Missing ones are skipped. */
export const CODEBASE_FILES = ["demo.html", "demo.css", "demo.ts", "DECISIONS.md", "notes/claude-code-session-2026-03-18.md"] as const;

/** One of DEMO_FILES from the project folder, ready to serve. `.ts` is transpiled to JavaScript. */
export async function projectFile(name: string): Promise<{ body: string; type: string } | null> {
  const root = dir;
  if (!root || !(DEMO_FILES as readonly string[]).includes(name)) return null;
  let src: string;
  try { src = await readFile(join(root, name), "utf8"); } catch { return null; }
  if (name.endsWith(".ts")) {
    // Node's own type stripping (erasable syntax only; the packaged app has no Vite); else, or for enums and the like,
    // Vite's esbuild.
    const { stripTypeScriptTypes } = await import("node:module");
    try { if (stripTypeScriptTypes) return { body: stripTypeScriptTypes(src), type: "text/javascript" }; } catch { /* not erasable */ }
    const { transformWithEsbuild } = await import("vite");
    const out = await transformWithEsbuild(src, name, { loader: "ts" });
    return { body: out.code, type: "text/javascript" };
  }
  return { body: src, type: name.endsWith(".html") ? "text/html" : "text/css" };
}

/** Calls `onChange(name)` after a demo file is written (debounced, so one save is one call). Returns a stop function. */
export function watchProject(onChange: (name: string) => void): () => void {
  const root = dir;
  if (!root) return () => {};
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const watcher = watch(root, (_event, name) => {
    if (!name || !(DEMO_FILES as readonly string[]).includes(name)) return;
    clearTimeout(timers.get(name));
    timers.set(name, setTimeout(() => { timers.delete(name); onChange(name); }, 120));
  });
  watcher.on("error", () => {});
  return () => {
    watcher.close();
    for (const t of timers.values()) clearTimeout(t);
  };
}
