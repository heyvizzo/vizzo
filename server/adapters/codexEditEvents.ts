import { isAbsolute, normalize } from "node:path";

export type CodexEditChange =
  | { path: string; from: string; to: null }
  | { path: string; patch: string };

export interface CodexEditBatch {
  sessionId: string;
  toolCallId: string;
  changes: CodexEditChange[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/;
const NO_NEWLINE = "\\ No newline at end of file";
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\s\u0000-\u001f]/u.test(value);
}

function isPath(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") && !LONE_SURROGATE.test(value)
    && isAbsolute(value) && normalize(value) === value;
}

/** The observed wire uses bare unified hunks. Validate their structure and pass the original bytes to the ledger. */
function isNumberedPatch(diff: string): boolean {
  if (!diff.endsWith("\n")) return false;
  const lines = diff.slice(0, -1).split("\n");
  let index = 0;
  let oldEnd = 0;
  let newEnd = 0;
  let oldEof = false;
  let newEof = false;
  while (index < lines.length) {
    const header = HUNK.exec(lines[index++]!);
    if (!header || oldEof || newEof) return false;
    const oldStart = Number(header[1]);
    const oldCount = Number(header[2] ?? 1);
    const newStart = Number(header[3]);
    const newCount = Number(header[4] ?? 1);
    if (![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger)) return false;
    // A hunk with no context or removed lines gives no evidence of the preimage.
    if (!oldStart || !oldCount || (newCount > 0 && !newStart)) return false;
    const oldIndex = oldStart - 1;
    const newIndex = newCount ? newStart - 1 : newStart;
    if (oldIndex < oldEnd || newIndex < newEnd || oldIndex - oldEnd !== newIndex - newEnd) return false;

    let oldRemaining = oldCount;
    let newRemaining = newCount;
    let edited = false;
    while (index < lines.length && !lines[index]!.startsWith("@@ ")) {
      const prefix = lines[index++]![0];
      if (prefix !== " " && prefix !== "-" && prefix !== "+") return false;
      if (prefix !== "+" && (oldEof || --oldRemaining < 0)) return false;
      if (prefix !== "-" && (newEof || --newRemaining < 0)) return false;
      if (prefix !== " ") edited = true;
      if (lines[index] === NO_NEWLINE) {
        if (prefix !== "+") oldEof = true;
        if (prefix !== "-") newEof = true;
        index++;
      }
    }
    if (oldRemaining !== 0 || newRemaining !== 0 || !edited) return false;
    oldEnd = oldIndex + oldCount;
    newEnd = newIndex + newCount;
  }
  return true;
}

/** Parse one successful live fileChange notification. The ledger deduplicates replays by the returned IDs. */
export function parseCodexEditEvent(method: string, params: unknown): CodexEditBatch | null {
  if (method !== "item/completed") return null;
  const envelope = record(params);
  const sessionId = envelope?.threadId;
  const turnId = envelope?.turnId;
  const item = record(envelope?.item);
  if (!isId(sessionId) || !isId(turnId) || item?.type !== "fileChange" || item.status !== "completed" || !isId(item.id)) return null;
  if (!Array.isArray(item.changes) || item.changes.length === 0) return null;

  const changes: CodexEditChange[] = [];
  const seenPaths = new Set<string>();
  for (const raw of item.changes) {
    const change = record(raw);
    const kind = record(change?.kind);
    const path = change?.path;
    const diff = change?.diff;
    if (!isPath(path) || typeof diff !== "string" || LONE_SURROGATE.test(diff) || !kind) return null;
    const pathKey = path.normalize("NFC").toUpperCase().normalize("NFC");
    if (seenPaths.has(pathKey)) return null;
    seenPaths.add(pathKey);

    // Adds and moves can overwrite an existing file without reporting its previous entry.
    if (kind.type === "delete" && !("move_path" in kind)) changes.push({ path, from: diff, to: null });
    else if (kind.type === "update" && kind.move_path === null && isNumberedPatch(diff)) changes.push({ path, patch: diff });
    else return null;
  }
  return { sessionId, toolCallId: JSON.stringify([turnId, item.id]), changes };
}
