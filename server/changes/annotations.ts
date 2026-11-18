import { ABSENT, bytesFor, type Content, type Entry } from "./entries.ts";
import { lineCount, lineDiff, type HunkRange } from "./lineDiff.ts";

export interface Ownership {
  owners: (string | null)[];
  ties: string[];
}

export interface Link {
  executionId: string;
  key: string;
  move?: string;
}

interface Range { start: number; end: number }
interface Span<T> extends Range { value: T }
interface Line {
  baseStart?: number;
  by: Ownership;
  replaced: Range[];
}

export interface Annotation {
  lines: Span<Line>[];
  tombstones: Span<Ownership>[];
  presence: Ownership;
  moves: string[];
}

export interface OwnedHunk {
  kind: "content" | "presence" | "type" | "mode" | "opaque";
  ownership: Ownership;
  range?: HunkRange;
  reason?: string;
}

const OTHER: Ownership = { owners: [null], ties: [] };

export function combine(parts: readonly Ownership[]): Ownership {
  return {
    owners: [...new Set(parts.flatMap((part) => part.owners))].sort((a, b) => (a ?? "").localeCompare(b ?? "")),
    ties: [...new Set(parts.flatMap((part) => part.ties))].sort(),
  };
}

function emptyLines(entry: Entry, content: Content): Span<Line>[] {
  const end = lineCount(bytesFor(entry, content));
  return end ? [{ start: 0, end, value: { baseStart: 0, by: OTHER, replaced: [] } }] : [];
}

export function initialAnnotation(entry: Entry, content: Content): Annotation {
  return { lines: emptyLines(entry, content), tombstones: [], presence: OTHER, moves: [] };
}

function firstOverlap<T>(spans: Span<T>[], start: number): number {
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (spans[mid]!.end <= start) low = mid + 1;
    else high = mid;
  }
  return low;
}

function overlaps<T>(spans: Span<T>[], start: number, end: number): Span<T>[] {
  const result: Span<T>[] = [];
  if (start >= end) return result;
  for (let index = firstOverlap(spans, start); index < spans.length; index++) {
    const span = spans[index]!;
    if (span.start >= end) break;
    result.push(span);
  }
  return result;
}

function copyLines(lines: Span<Line>[], start: number, end: number, shift: number): Span<Line>[] {
  return overlaps(lines, start, end).map((span) => {
    const left = Math.max(start, span.start);
    const value = { ...span.value };
    if (value.baseStart !== undefined) value.baseStart += left - span.start;
    return { start: left + shift, end: Math.min(span.end, end) + shift, value };
  });
}

function setTombstone(tombstones: Span<Ownership>[], range: Range, by: Ownership, merge: boolean): void {
  const first = firstOverlap(tombstones, range.start);
  const existing = overlaps(tombstones, range.start, range.end);
  const result: Span<Ownership>[] = [];
  let cursor = range.start;
  for (const span of existing) {
    if (span.start < range.start) result.push({ ...span, end: range.start });
    const start = Math.max(range.start, span.start);
    const end = Math.min(range.end, span.end);
    if (cursor < start) result.push({ start: cursor, end: start, value: by });
    result.push({ start, end, value: merge ? combine([span.value, by]) : by });
    cursor = end;
    if (span.end > range.end) result.push({ ...span, start: range.end });
  }
  if (cursor < range.end) result.push({ start: cursor, end: range.end, value: by });
  // A pathological highly fragmented range can exceed JavaScript's argument limit for splice.
  if (result.length < 10_000) tombstones.splice(first, existing.length, ...result);
  else {
    const tail = tombstones.slice(first + existing.length);
    tombstones.length = first;
    for (const span of result) tombstones.push(span);
    for (const span of tail) tombstones.push(span);
  }
}

function mergedRanges(ranges: Range[]): Range[] {
  const result: Range[] = [];
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    const last = result.at(-1);
    if (last && last.end >= range.start) last.end = Math.max(last.end, range.end);
    else result.push({ ...range });
  }
  return result;
}

export function applyLink(annotation: Annotation, before: Entry, after: Entry, content: Content, link?: Link): Annotation {
  const oldBytes = bytesFor(before, content);
  const newBytes = bytesFor(after, content);
  const presentChanged = (before.kind === "absent") !== (after.kind === "absent");
  const structure = link ? { owners: [link.executionId], ties: link.move ? [link.move] : [] } : OTHER;
  const presence = presentChanged ? structure : annotation.presence;
  const moves = link?.move ? [...new Set([...annotation.moves, link.move])] : annotation.moves;
  // An unreadable version is an opaque break in custody. No later link inherits its line labels.
  if (before.kind === "opaque" || after.kind === "opaque") {
    return { lines: emptyLines(after, content).map((line) => ({ ...line, value: { by: OTHER, replaced: [] } })),
      tombstones: [], presence: OTHER, moves };
  }
  const typeChanged = before.kind !== "absent" && after.kind !== "absent" && before.kind !== after.kind;
  const hunks = typeChanged
    ? [{ oldStart: 0, oldCount: lineCount(oldBytes), newStart: 0, newCount: lineCount(newBytes) }]
    : lineDiff(oldBytes, newBytes);
  const tombstones = annotation.tombstones.slice();
  const lines: Span<Line>[] = [];
  let oldEnd = 0;
  let newEnd = 0;
  for (const [index, hunk] of hunks.entries()) {
    const { oldStart, oldCount, newStart, newCount } = hunk;
    for (const span of copyLines(annotation.lines, oldEnd, oldStart, newEnd - oldEnd)) lines.push(span);
    oldEnd = oldStart + oldCount;
    newEnd = newStart + newCount;
    const removed = copyLines(annotation.lines, oldStart, oldEnd, 0);
    const own: Ownership = link ? {
      owners: [link.executionId],
      ties: [link.move ?? JSON.stringify([link.key, index])],
    } : OTHER;
    const by = link ? combine([own, ...removed.filter((span) => span.value.baseStart === undefined).map((span) => span.value.by)]) : own;
    const replaced: Range[] = [];
    for (const { start, end, value } of removed) {
      if (value.baseStart !== undefined) {
        const range = { start: value.baseStart, end: value.baseStart + end - start };
        setTombstone(tombstones, range, by, false);
        replaced.push(range);
      }
      for (const range of value.replaced) {
        setTombstone(tombstones, range, by, true);
        replaced.push(range);
      }
    }
    if (newCount) lines.push({ start: newStart, end: newEnd, value: { by, replaced: mergedRanges(replaced) } });
  }
  for (const span of copyLines(annotation.lines, oldEnd, lineCount(oldBytes), newEnd - oldEnd)) lines.push(span);
  return { lines, tombstones, presence, moves };
}

export function hunkOwnership(base: Entry, current: Entry, annotation: Annotation, content: Content, path: string): OwnedHunk[] {
  if (base.kind === "opaque" || current.kind === "opaque") {
    const reason = current.kind === "opaque" ? current.reason : base.kind === "opaque" ? base.reason : undefined;
    return [{ kind: "opaque", ownership: OTHER, reason }];
  }
  const oldBytes = bytesFor(base, content);
  const newBytes = bytesFor(current, content);
  const presentChanged = (base.kind === "absent") !== (current.kind === "absent");
  const typeChanged = base.kind !== "absent" && current.kind !== "absent" && base.kind !== current.kind;
  const structuralTie = JSON.stringify(["entry", path]);
  const dependency: Ownership = { owners: [], ties: [structuralTie] };
  const hunks: OwnedHunk[] = lineDiff(oldBytes, newBytes).map((range) => {
    const oldEnd = range.oldStart + range.oldCount;
    const newEnd = range.newStart + range.newCount;
    const added = overlaps(annotation.lines, range.newStart, newEnd);
    const removed = overlaps(annotation.tombstones, range.oldStart, oldEnd);
    const uncovered = <T>(spans: Span<T>[], start: number, end: number): number => spans.reduce(
      (remaining, span) => remaining - (Math.min(end, span.end) - Math.max(start, span.start)), end - start,
    );
    const ownership = combine([
      ...added.map((span) => span.value.by),
      ...removed.map((span) => span.value),
      ...(uncovered(added, range.newStart, newEnd) || uncovered(removed, range.oldStart, oldEnd) ? [OTHER] : []),
      ...(presentChanged || typeChanged ? [dependency] : []),
    ]);
    return { kind: "content", range, ownership };
  });
  if (presentChanged) hunks.push({ kind: "presence", ownership: combine([annotation.presence, dependency]) });
  if (typeChanged) hunks.push({ kind: "type", ownership: combine([OTHER, dependency]) });
  const defaultMode = base.kind === "file" ? base.mode : "100644";
  if (current.kind === "file" && current.mode !== defaultMode) hunks.push({ kind: "mode", ownership: OTHER });
  const moves = { owners: [], ties: annotation.moves };
  if (moves.ties.length) for (const hunk of hunks) hunk.ownership = combine([hunk.ownership, moves]);
  return hunks;
}

/** Keep surviving line labels on an external HEAD move. Tombstones no longer have the same base. */
export function rebaseAnnotation(base: Entry, current: Entry, annotation: Annotation, content: Content): Annotation {
  if (base.kind === "opaque" || current.kind === "opaque") return initialAnnotation(ABSENT, content);
  const oldBytes = bytesFor(base, content);
  const newBytes = bytesFor(current, content);
  const lines: Span<Line>[] = [];
  let oldEnd = 0;
  let newEnd = 0;
  const common = (end: number) => {
    if (newEnd < end) lines.push({ start: newEnd, end, value: { baseStart: oldEnd, by: OTHER, replaced: [] } });
  };
  for (const hunk of lineDiff(oldBytes, newBytes)) {
    common(hunk.newStart);
    for (const span of copyLines(annotation.lines, hunk.newStart, hunk.newStart + hunk.newCount, 0)) {
      lines.push({ ...span, value: { by: span.value.by, replaced: [] } });
    }
    oldEnd = hunk.oldStart + hunk.oldCount;
    newEnd = hunk.newStart + hunk.newCount;
  }
  common(lineCount(newBytes));
  return {
    lines, tombstones: [], presence: base.kind === "absent" ? annotation.presence : OTHER, moves: annotation.moves,
  };
}
