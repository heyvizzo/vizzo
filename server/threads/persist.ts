// The thread list on disk, so threads and their markers come back after the app is closed and opened again
// (docs/PLAN-threads.md, "Lifetime"). Each saved thread keeps its record (messages, anchor, state) and what its
// harness session needs to be resumed: the spec it was opened with (harness, model, prompt, project folder) and the
// harness's own saved session id. The next request on a restored thread resumes that session natively.
// File: $VIZZO_THREADS_FILE, default ~/.config/vizzo/threads.json (the packaged app: Application Support).
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { LlmChoice } from "../../shared/config.ts";
import type { ThreadInfo } from "../../shared/threads.ts";
import type { AgentSpec, SessionRef } from "../adapters/harnesses.ts";

const VERSION = 1;

/** What a restored thread's harness session is reopened with. */
export interface ThreadResume {
  choice: LlmChoice;
  spec: AgentSpec;
  ref?: SessionRef;
}

export interface SavedThread {
  info: ThreadInfo;
  projectFolder?: string | null;
  resume?: ThreadResume;
  activeRequest?: { executionId: string; request: string };
}

export function threadsFile(): string {
  return process.env.VIZZO_THREADS_FILE ?? join(homedir(), ".config", "vizzo", "threads.json");
}

/** The saved threads; [] when there is no file or it can't be read. */
export function loadThreads(file: string, strict = false): SavedThread[] {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
  try {
    const data = JSON.parse(raw) as { version?: unknown; threads?: unknown };
    if (data.version !== VERSION || !Array.isArray(data.threads)) throw new Error("Unsupported thread file version");
    const threads = data.threads.filter((t): t is SavedThread => isSaved(t));
    if (strict && threads.length !== data.threads.length) throw new Error("Invalid records in the saved thread file");
    return threads;
  } catch (e) {
    if (strict) throw e;
    console.warn(`[threads] can't read ${file}:`, e instanceof Error ? e.message : e);
    return [];
  }
}

/** Written whole, through a temp file, so a crash mid-write leaves the previous list. */
export function writeThreads(file: string, threads: SavedThread[], durable = false): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ version: VERSION, threads }));
      if (durable) fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(tmp, file);
    if (durable) {
      const parent = openSync(dir, "r");
      try { fsyncSync(parent); } finally { closeSync(parent); }
    }
  } finally { rmSync(tmp, { force: true }); }
}

function isSaved(t: unknown): boolean {
  const info = (t as SavedThread | null)?.info;
  return !!info && typeof info.threadId === "string" && typeof info.pageUrl === "string"
    && !!info.anchor && typeof info.anchor.selector === "string" && Array.isArray(info.messages);
}
