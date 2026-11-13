// The local trace log (Settings → Debugging → "Save full traces"; RunConfig.captureTrace). While it is on, every model
// call of a turn (router, progress lines, solver; the runs a turn starts on threads and jobs too) is saved as it
// happens: the prompt as it was dispatched (Vizzo's prompt layers, the message after the history or notes were
// added, how it reached its session and that session's id, the launch settings) and the raw response (or error).
// The harness's own system prompt and the tool calls inside a harness's turn are not in it: Vizzo only sees the
// harness boundary.
//
// Format (version 1): JSON Lines, one record per line, in <dir>/<YYYY-MM-DD>.jsonl (UTC date):
//   { v: 1, at: <ISO time>, kind: "prompt" | "response", turnId, jobId?, callId, prompt? | response? }
// `callId` pairs a prompt with its response; `jobId` is a background job's id or a thread's id.
// Dir: $VIZZO_TRACE_DIR, default ~/.config/vizzo/traces. Nothing is written while the setting is off; what was saved
// stays until it is deleted (deleteTraces) or expires: files older than TRACE_MAX_DAYS go, then the oldest until the
// folder is under TRACE_MAX_BYTES. Image payloads are already redacted in what reaches here (adapters/drawing.ts
// redactImagePayloads); launch commands carry no credentials (the harnesses use their own logins).
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LlmPrompt, LlmResponse } from "../shared/protocol.ts";

export const TRACE_VERSION = 1;
export const TRACE_MAX_DAYS = 7;
export const TRACE_MAX_BYTES = 250 * 1024 * 1024;
/** How often the retention pass runs while traces are being written. */
const PRUNE_EVERY_MS = 10 * 60_000;

export type TraceRecord =
  | { kind: "prompt"; turnId: string; jobId?: string; callId: string; prompt: LlmPrompt }
  | { kind: "response"; turnId: string; jobId?: string; callId: string; response: LlmResponse };

export const traceDir = (): string => process.env.VIZZO_TRACE_DIR ?? join(homedir(), ".config", "vizzo", "traces");

let lastPrune = 0;

/** Append one record. Never throws: a trace that can't be written must not fail the turn. */
export function recordTrace(rec: TraceRecord, now = new Date()): void {
  try {
    const dir = traceDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${now.toISOString().slice(0, 10)}.jsonl`), JSON.stringify({ v: TRACE_VERSION, at: now.toISOString(), ...rec }) + "\n");
    if (now.getTime() - lastPrune > PRUNE_EVERY_MS) {
      lastPrune = now.getTime();
      pruneTraces(now);
    }
  } catch (e) {
    console.warn(`[trace] couldn't save a record: ${e instanceof Error ? e.message : String(e)}`);
  }
}

interface TraceFile { name: string; path: string; bytes: number }

/** The saved trace files, oldest first (their names are dates). */
export function traceFiles(dir = traceDir()): TraceFile[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort().flatMap((name) => {
    const path = join(dir, name);
    try { return [{ name, path, bytes: statSync(path).size }]; } catch { return []; }
  });
}

/** Retention: files older than `maxDays` go, then the oldest until the folder is under `maxBytes` (today's stays). */
export function pruneTraces(now = new Date(), dir = traceDir(), maxDays = TRACE_MAX_DAYS, maxBytes = TRACE_MAX_BYTES): string[] {
  const removed: string[] = [];
  const cutoff = new Date(now.getTime() - maxDays * 86_400_000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  let files = traceFiles(dir);
  const drop = (f: TraceFile): void => { try { rmSync(f.path); removed.push(f.name); } catch { /* still there next time */ } };
  for (const f of files.filter((x) => x.name.slice(0, 10) < cutoff)) drop(f);
  files = files.filter((f) => !removed.includes(f.name));
  let total = files.reduce((n, f) => n + f.bytes, 0);
  for (const f of files) {
    if (total <= maxBytes || f.name.slice(0, 10) === today) break;
    drop(f);
    total -= f.bytes;
  }
  return removed;
}

/** What is saved: the folder, each file's size, and the retention limits (Settings shows it). */
export function traceStatus(dir = traceDir()): { dir: string; files: { name: string; bytes: number }[]; bytes: number; maxDays: number; maxBytes: number } {
  const files = traceFiles(dir);
  return { dir, files: files.map(({ name, bytes }) => ({ name, bytes })), bytes: files.reduce((n, f) => n + f.bytes, 0), maxDays: TRACE_MAX_DAYS, maxBytes: TRACE_MAX_BYTES };
}

/** Delete every saved trace. Returns how many files went. */
export function deleteTraces(dir = traceDir()): number {
  let n = 0;
  for (const f of traceFiles(dir)) { try { rmSync(f.path); n++; } catch { /* in use */ } }
  return n;
}
