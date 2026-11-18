import { Buffer } from "node:buffer";

export type FileMode = "100644" | "100755";
export type Entry =
  | { kind: "absent" }
  | { kind: "file"; mode: FileMode; blob: string }
  | { kind: "symlink"; blob: string }
  | { kind: "opaque"; reason: string };

export type ReadEntry =
  | Extract<Entry, { kind: "absent" | "opaque" }>
  | { kind: "file"; mode: FileMode; bytes: Buffer }
  | { kind: "symlink"; bytes: Buffer };

export const ABSENT = { kind: "absent" } as const;

export function sameEntry(a: Entry, b: Entry): boolean {
  if (a.kind === "file" && b.kind === "file") return a.mode === b.mode && a.blob === b.blob;
  if (a.kind === "symlink" && b.kind === "symlink") return a.blob === b.blob;
  return a.kind === "absent" && b.kind === "absent";
}

export interface Content {
  put(bytes: Buffer): string;
  get(blob: string): Buffer;
}

export function storeEntry(entry: ReadEntry, content: Content): Entry {
  if (entry.kind === "file") return { kind: "file", mode: entry.mode, blob: content.put(entry.bytes) };
  if (entry.kind === "symlink") return { kind: "symlink", blob: content.put(entry.bytes) };
  return entry;
}

export function bytesFor(entry: Entry, content: Content): Buffer {
  return entry.kind === "file" || entry.kind === "symlink" ? content.get(entry.blob) : Buffer.alloc(0);
}
