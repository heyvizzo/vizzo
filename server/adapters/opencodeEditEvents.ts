import { isAbsolute, normalize } from "node:path";

type OpencodeChange =
  | { path: string; from: null; to: string }
  // Updates and deletes require an existing preimage. A delete patch must apply to empty bytes.
  | { path: string; patch: string; to?: null };

export interface OpencodeEditEvent {
  sessionId: string;
  /** The OpenCode part ID is stable across updates and replays. */
  toolCallId: string;
  changes: OpencodeChange[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}

function filePath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && !value.includes("\0");
}

function utf8Text(value: unknown): value is string {
  return typeof value === "string" && !/[\uD800-\uDFFF]/u.test(value);
}

function numberedPatch(path: string, patch: unknown, deletion: boolean): patch is string {
  if (!utf8Text(patch)) return false;
  const header = `Index: ${path}\n===================================================================\n--- ${path}\n+++ ${path}\n`;
  if (!patch.startsWith(header)) return false;

  // Split on LF only. A carriage return in a hunk row is part of the reported content.
  const lines = patch.slice(header.length).split("\n");
  if (lines.pop() !== "" || lines.length === 0) return false;
  let index = 0;
  let oldEnd = 0;
  let newEnd = 0;
  while (index < lines.length) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(lines[index++] ?? "");
    if (!match) return false;
    let oldCount = Number(match[2] ?? 1);
    let newCount = Number(match[4] ?? 1);
    const oldStart = Number(match[1]) - Number(oldCount > 0);
    const newStart = Number(match[3]) - Number(newCount > 0);
    const oldGap = oldStart - oldEnd;
    const newGap = newStart - newEnd;
    if (!Number.isSafeInteger(oldStart) || !Number.isSafeInteger(newStart) || oldGap < 0 || oldGap !== newGap ||
        oldCount > lines.length || newCount > lines.length || (oldCount === 0 && newCount === 0)) return false;
    if (deletion && (index !== 1 || oldStart !== 0 || newStart !== 0 || newCount !== 0)) return false;
    oldEnd = oldStart + oldCount;
    newEnd = newStart + newCount;

    while (oldCount > 0 || newCount > 0) {
      const prefix = lines[index++]?.[0];
      if (prefix !== "+" && prefix !== "-" && prefix !== " ") return false;
      if (prefix !== "+") oldCount--;
      if (prefix !== "-") newCount--;
      if (oldCount < 0 || newCount < 0) return false;
      if (lines[index] === "\\ No newline at end of file") index++;
    }
  }
  return true;
}

function patchChanges(files: unknown): OpencodeChange[] {
  const changes: OpencodeChange[] = [];
  if (!Array.isArray(files)) return changes;
  const paths = new Set<string>();
  for (const value of files) {
    const file = record(value);
    if (!file || !filePath(file.filePath)) return [];
    const { filePath: path, patch, type } = file;
    // Adds and moves can silently overwrite an existing file and alias a sibling path.
    if (file.movePath !== undefined || (type !== "update" && type !== "delete")) return [];
    const key = normalize(path).normalize("NFC").toLowerCase();
    if (paths.has(key) || !numberedPatch(path, patch, type === "delete")) return [];
    paths.add(key);
    changes.push(type === "delete" ? { path, patch, to: null } : { path, patch });
  }
  return changes;
}

/** Reads a completed tool part or its `message.part.updated` SSE event. The ledger deduplicates by the part ID. */
export function opencodeEditEvent(value: unknown): OpencodeEditEvent | undefined {
  const event = record(value);
  const properties = record(event?.properties);
  const part = event?.type === "message.part.updated" ? record(properties?.part) : event;
  if (part?.type !== "tool" || typeof part.id !== "string" || !part.id.trim() ||
      typeof part.sessionID !== "string" || !part.sessionID.trim()) return;
  if (properties?.sessionID !== undefined && properties.sessionID !== part.sessionID) return;
  const state = record(part.state);
  const metadata = record(state?.metadata);
  if (state?.status !== "completed" || metadata?.truncated !== false) return;

  const { sessionID: sessionId, id: toolCallId } = part;
  if (part.tool === "apply_patch") {
    const changes = patchChanges(metadata.files);
    if (changes.length) return { sessionId, toolCallId, changes };
  }
  // The edit tool normalizes CRLF in its diff. A write only reports prior existence, so attribute creations.
  if (part.tool !== "write" || metadata.exists !== false) return;
  const input = record(state.input);
  const path = metadata.filepath;
  const content = input?.content;
  if (!filePath(path) || input?.filePath !== path || !utf8Text(content)) return;
  return { sessionId, toolCallId, changes: [{ path, from: null, to: content }] };
}
