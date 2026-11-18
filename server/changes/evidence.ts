import { Buffer } from "node:buffer";
import type { HunkRange } from "./lineDiff.ts";

export const MAX_FILE_BYTES = 5_000_000;
export const PENDING_MS = 120_000;
export const MAX_VERSIONS = 20;
export const TOO_LARGE = "Too large for Vizzo to track";

export type ExactBytes = string | Uint8Array;

export type EditChange =
  | { path: string; from: ExactBytes | null; to: ExactBytes | null }
  | { path: string; patch: string; to?: null }
  // A move must explicitly report both entries before and after the operation.
  | { path: string; from: ExactBytes; to: null; move: { path: string; from: ExactBytes | null; to: ExactBytes } };

export interface EditBatch {
  executionId: string;
  sessionId: string;
  toolCallId: string;
  outcome: "completed" | "failed" | "cancelled" | "partial";
  changes: readonly EditChange[];
}

export function exactText(value: unknown): value is string {
  return typeof value === "string" && !/[\uD800-\uDFFF]/u.test(value);
}

export function exactBytes(value: unknown): Buffer | undefined {
  if (exactText(value)) return Buffer.from(value, "utf8");
  if (value instanceof Uint8Array) return Buffer.from(value);
}

export function batchKey(batch: Pick<EditBatch, "executionId" | "sessionId" | "toolCallId">): string {
  const ids = [batch.executionId, batch.sessionId, batch.toolCallId];
  if (ids.some((id) => !exactText(id) || !id.trim() || id.includes("\0"))) throw new Error("Missing or malformed edit batch identity");
  return JSON.stringify(ids);
}

/** One Latin-1 code unit per byte so splitting never decodes or normalizes the file. */
export function splitLines(bytes: Buffer): string[] {
  const text = bytes.toString("latin1");
  const rows = text.split("\n");
  const last = rows.pop()!;
  for (let index = 0; index < rows.length; index++) rows[index] += "\n";
  if (last) rows.push(last);
  return rows;
}

interface PatchHunk {
  oldStart: number;
  newStart: number;
  before: string[];
  after: string[];
  edits: HunkRange[];
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/;
const NO_EOL = "\\ No newline at end of file";

export function parsePatch(path: string, patch: string): PatchHunk[] | undefined {
  const prefix = `Index: ${path}\n===================================================================\n--- ${path}\n+++ ${path}\n`;
  const bare = patch.startsWith(prefix) ? patch.slice(prefix.length) : patch;
  const bytes = exactBytes(bare);
  if (!bytes?.length || bytes.byteLength > MAX_FILE_BYTES || bytes[bytes.length - 1] !== 10) return;
  const rows = bytes.toString("latin1").slice(0, -1).split("\n");
  const result: PatchHunk[] = [];
  let index = 0;
  let oldEnd = 0;
  let newEnd = 0;
  let oldEof = false;
  let newEof = false;
  while (index < rows.length) {
    const header = HEADER.exec(rows[index++]!);
    if (!header || oldEof || newEof) return;
    const oldCount = Number(header[2] ?? 1);
    const newCount = Number(header[4] ?? 1);
    const oldStart = Number(header[1]) - Number(oldCount !== 0);
    const newStart = Number(header[3]) - Number(newCount !== 0);
    if (![oldStart, newStart, oldCount, newCount].every(Number.isSafeInteger) ||
        oldStart < oldEnd || newStart - newEnd !== oldStart - oldEnd ||
        oldCount === 0 || oldCount > rows.length || newCount > rows.length) return;
    const before: string[] = [];
    const after: string[] = [];
    const edits: HunkRange[] = [];
    let edit: HunkRange | undefined;
    while (before.length < oldCount || after.length < newCount) {
      const row = rows[index++];
      const sign = row?.[0];
      if (!row || (sign !== " " && sign !== "-" && sign !== "+")) return;
      const newline = rows[index] !== NO_EOL;
      if (!newline) index++;
      const line = row.slice(1) + (newline ? "\n" : "");
      if (!line) return;
      if (sign === " ") edit = undefined;
      else {
        if (!edit) {
          edit = { oldStart: oldStart + before.length, oldCount: 0, newStart: newStart + after.length, newCount: 0 };
          edits.push(edit);
        }
        if (sign === "-") edit.oldCount++;
        else edit.newCount++;
      }
      if (sign !== "+") {
        if (oldEof || before.length >= oldCount) return;
        before.push(line);
        oldEof = !newline;
      }
      if (sign !== "-") {
        if (newEof || after.length >= newCount) return;
        after.push(line);
        newEof = !newline;
      }
    }
    if (!edits.length) return;
    result.push({ oldStart, newStart, before, after, edits });
    oldEnd = oldStart + before.length;
    newEnd = newStart + after.length;
  }
  return result.length ? result : undefined;
}

/** Apply at the stated positions, preserving untouched bytes and both EOF markers. */
export function applyExactPatch(before: Buffer, hunks: PatchHunk[], deletion: boolean): Buffer | undefined {
  const source = splitLines(before);
  const output: string[] = [];
  let end = 0;
  for (const hunk of hunks) {
    if (hunk.oldStart + hunk.before.length > source.length) return;
    for (; end < hunk.oldStart; end++) output.push(source[end]!);
    if (output.length !== hunk.newStart) return;
    for (const line of hunk.before) if (source[end++] !== line) return;
    for (const line of hunk.after) output.push(line);
  }
  if (deletion && (output.length || end !== source.length)) return;
  for (; end < source.length; end++) output.push(source[end]!);
  for (let index = 0; index + 1 < output.length; index++) if (!output[index]!.endsWith("\n")) return;
  return Buffer.from(output.join(""), "latin1");
}
