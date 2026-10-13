// Cursor-lab sessions and their fixture files (ARCHITECTURE §6.1): Uxx.wav, Uxx.cursor.json, Uxx.labels.json.
import { isPointingWord, normalizeWord } from "../../shared/pointing.ts";
import type { CursorSample, PageClick, PageEvents, PageHighlight, PageSelection, PointingTarget, Word } from "../../shared/protocol.ts";
import { clickKind } from "./pageContext.ts";

export interface LabelTarget { elementPath: string | null; dataSource: string | null; label: string | null }

export interface PointingLabel {
  /** Index into the session's words[]. */
  wordIndex: number;
  /** Normalized pointing word ("this"). */
  word: string;
  /** Seconds from turn audio start (copied from the word for readability). */
  start: number;
  end: number;
  /** The element the user meant; null = not labeled yet. */
  target: LabelTarget | null;
}

/** Uxx.cursor.json */
export interface CursorFile {
  version: 1;
  kind: "cursor";
  id: string;
  createdAt: string;
  transcript: string;
  words: Word[];
  /** Cursor trail; t is ms relative to tAudioStart (first captured audio sample), may be negative. */
  samples: CursorSample[];
  /** Window size + demo scroller size at record time, for reference. */
  viewport?: { width: number; height: number };
  /**
   * Click events during the turn (single/double/triple/multi; t, tEnd and times[] relative to tAudioStart,
   * like samples). Optional: older files lack it, and their clicks have no kind (loaded as single clicks).
   */
  clicks?: PageClick[];
  /** Text already highlighted when the recording started (t relative to tAudioStart). Optional. */
  preselected?: PageSelection | null;
  /** Highlights made during the recording, in order (tStart / t relative to tAudioStart). Optional. */
  highlights?: PageHighlight[];
}

/** Uxx.labels.json */
export interface LabelsFile {
  version: 1;
  kind: "labels";
  id: string;
  labels: PointingLabel[];
}

/** In-memory session. Sample times are relative to tAudioStart (so resolvers use tAudioStart = 0). */
export interface LabSession {
  id: string;
  createdAt: string;
  transcript: string;
  words: Word[];
  samples: CursorSample[];
  labels: PointingLabel[];
  wav?: Blob;
  /** What the server's resolver sent (live turns only). */
  serverTargets?: PointingTarget[];
  viewport?: { width: number; height: number };
  /** What the user clicked / highlighted during the turn (PageEvents), times relative to tAudioStart. */
  clicks?: PageClick[];
  preselected?: PageSelection | null;
  highlights?: PageHighlight[];
}

/** The session's page events (empty lists / null when missing). */
export function sessionEvents(s: Pick<LabSession, "clicks" | "preselected" | "highlights">): PageEvents {
  return { clicks: s.clicks ?? [], preselected: s.preselected ?? null, highlights: s.highlights ?? [] };
}

/** Page events with every time shifted by `dt` ms (absolute <-> relative to tAudioStart). Copies. */
export function shiftEvents(ev: PageEvents, dt: number): PageEvents {
  return {
    clicks: ev.clicks.map((c) => ({ ...c, t: c.t + dt, tEnd: c.tEnd + dt, times: c.times.map((x) => x + dt) })),
    preselected: ev.preselected ? { ...ev.preselected, t: ev.preselected.t + dt } : null,
    highlights: ev.highlights.map((h) => ({ ...h, tStart: h.tStart + dt, t: h.t + dt })),
  };
}

/** Shift absolute client-time samples to be relative to tAudioStart, keeping those in [from, to] (absolute). */
export function toRelativeSamples(samples: readonly CursorSample[], tAudioStart: number, from = -Infinity, to = Infinity): CursorSample[] {
  return samples.filter((s) => s.t >= from && s.t <= to).map((s) => ({ ...s, t: s.t - tAudioStart }));
}

/** One unlabeled entry per pointing word; keeps existing labels whose wordIndex still matches. */
export function labelsFor(words: readonly Word[], existing: readonly PointingLabel[] = []): PointingLabel[] {
  const out: PointingLabel[] = [];
  words.forEach((w, i) => {
    if (!isPointingWord(w.text)) return;
    const word = normalizeWord(w.text);
    const prev = existing.find((l) => l.wordIndex === i && l.word === word);
    out.push({ wordIndex: i, word, start: w.start, end: w.end, target: prev?.target ?? null });
  });
  return out;
}

export function toCursorFile(s: LabSession): CursorFile {
  return {
    version: 1, kind: "cursor", id: s.id, createdAt: s.createdAt, transcript: s.transcript,
    words: s.words, samples: s.samples, ...(s.viewport ? { viewport: s.viewport } : {}),
    ...(s.clicks?.length ? { clicks: s.clicks } : {}), ...(s.preselected ? { preselected: s.preselected } : {}),
    ...(s.highlights?.length ? { highlights: s.highlights } : {}),
  };
}

export function toLabelsFile(s: LabSession): LabelsFile {
  return { version: 1, kind: "labels", id: s.id, labels: s.labels };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";

function isWord(v: unknown): v is Word {
  return isObj(v) && typeof v.text === "string" && isNum(v.start) && isNum(v.end);
}
function isSample(v: unknown): v is CursorSample {
  return isObj(v) && isNum(v.t) && isNum(v.x) && isNum(v.y) && isNum(v.scrollX) && isNum(v.scrollY)
    && strOrNull(v.elementPath) && strOrNull(v.dataSource) && strOrNull(v.label);
}
function isTarget(v: unknown): v is LabelTarget {
  return isObj(v) && strOrNull(v.elementPath) && strOrNull(v.dataSource) && strOrNull(v.label);
}
const optStrOrNull = (v: unknown) => v === undefined || strOrNull(v);
const isRef = (v: unknown): v is Record<string, unknown> => isObj(v) && isTarget(v) && optStrOrNull(v.container);
const refOf = (v: Record<string, unknown>) => ({
  elementPath: v.elementPath as string | null, dataSource: v.dataSource as string | null, label: v.label as string | null,
  ...(v.container !== undefined ? { container: v.container as string | null } : {}),
});
/** A click event; old files' clicks (no kind/count/times) become single clicks. Null when malformed. */
export function toClick(v: unknown): PageClick | null {
  if (!isRef(v) || !isNum(v.t) || !isNum(v.x) || !isNum(v.y)) return null;
  const times = Array.isArray(v.times) && v.times.length && v.times.every(isNum) ? [...(v.times as number[])] : [v.t];
  const count = times.length;
  const tEnd = isNum(v.tEnd) ? v.tEnd : times[count - 1]!;
  return { ...refOf(v), kind: clickKind(count), count, t: v.t, tEnd, times, x: v.x, y: v.y };
}
function toSelection(v: unknown): PageSelection | null {
  return isRef(v) && isNum(v.t) && typeof v.text === "string" ? { ...refOf(v), t: v.t, text: v.text } : null;
}
function toHighlight(v: unknown): PageHighlight | null {
  if (!isRef(v) || !isNum(v.t) || typeof v.text !== "string") return null;
  return { ...refOf(v), text: v.text, tStart: isNum(v.tStart) ? v.tStart : v.t, t: v.t };
}
/** Every element converted, or null when it isn't an array or any element is malformed. */
function every<T>(xs: unknown, f: (v: unknown) => T | null): T[] | null {
  if (!Array.isArray(xs)) return null;
  const out = xs.map(f);
  return out.every((x) => x !== null) ? (out as T[]) : null;
}

/** Throws with a readable message on a malformed file. */
export function parseCursorFile(text: string): CursorFile {
  const v: unknown = JSON.parse(text);
  if (!isObj(v) || v.kind !== "cursor" || v.version !== 1) throw new Error("not a v1 cursor file");
  if (typeof v.id !== "string") throw new Error("cursor file: missing id");
  if (!Array.isArray(v.words) || !v.words.every(isWord)) throw new Error("cursor file: bad words");
  if (!Array.isArray(v.samples) || !v.samples.every(isSample)) throw new Error("cursor file: bad samples");
  return {
    version: 1, kind: "cursor", id: v.id, createdAt: typeof v.createdAt === "string" ? v.createdAt : "",
    transcript: typeof v.transcript === "string" ? v.transcript : v.words.map((w) => w.text).join(" "),
    words: v.words, samples: v.samples,
    ...(isObj(v.viewport) && isNum(v.viewport.width) && isNum(v.viewport.height)
      ? { viewport: { width: v.viewport.width, height: v.viewport.height } } : {}),
    ...pageFields(v),
  };
}

/**
 * clicks / preselected / highlights from a cursor file object (a malformed list is dropped). Old files: a
 * `selection` (the turn's last highlighted text) becomes the one highlight, with tStart = t.
 */
function pageFields(v: Record<string, unknown>): Pick<CursorFile, "clicks" | "preselected" | "highlights"> {
  const clicks = every(v.clicks, toClick);
  const preselected = toSelection(v.preselected);
  let highlights = every(v.highlights, toHighlight);
  if (v.highlights === undefined) {
    const old = toHighlight(v.selection);
    if (old) highlights = [old];
  }
  return {
    ...(clicks?.length ? { clicks } : {}), ...(preselected ? { preselected } : {}), ...(highlights?.length ? { highlights } : {}),
  };
}

export function parseLabelsFile(text: string): LabelsFile {
  const v: unknown = JSON.parse(text);
  if (!isObj(v) || v.kind !== "labels" || v.version !== 1) throw new Error("not a v1 labels file");
  if (typeof v.id !== "string" || !Array.isArray(v.labels)) throw new Error("labels file: missing id or labels");
  const labels = v.labels.map((l, i): PointingLabel => {
    if (!isObj(l) || !isNum(l.wordIndex) || typeof l.word !== "string" || !(l.target === null || isTarget(l.target)))
      throw new Error(`labels file: bad label #${i}`);
    return {
      wordIndex: l.wordIndex, word: l.word, start: isNum(l.start) ? l.start : 0, end: isNum(l.end) ? l.end : 0,
      target: l.target === null ? null : { elementPath: l.target.elementPath, dataSource: l.target.dataSource, label: l.target.label },
    };
  });
  return { version: 1, kind: "labels", id: v.id, labels };
}

export interface LoadedFile { name: string; text?: string; blob?: Blob }

const FILE_RE = /^(.+?)\.(cursor\.json|labels\.json|wav)$/i;

/** Group Uxx.* files into sessions. A session needs a cursor file; labels and wav are optional. */
export function sessionsFromFiles(files: readonly LoadedFile[]): { sessions: LabSession[]; errors: string[] } {
  const groups = new Map<string, { cursor?: LoadedFile; labels?: LoadedFile; wav?: LoadedFile }>();
  const errors: string[] = [];
  for (const f of files) {
    const m = FILE_RE.exec(f.name.split("/").pop()!);
    if (!m) {
      errors.push(`${f.name}: unrecognized file name`);
      continue;
    }
    const g = groups.get(m[1]!) ?? {};
    const kind = m[2]!.toLowerCase();
    if (kind === "wav") g.wav = f;
    else if (kind === "cursor.json") g.cursor = f;
    else g.labels = f;
    groups.set(m[1]!, g);
  }
  const sessions: LabSession[] = [];
  for (const [id, g] of groups) {
    if (!g.cursor?.text) {
      errors.push(`${id}: no ${id}.cursor.json`);
      continue;
    }
    try {
      const c = parseCursorFile(g.cursor.text);
      const lab = g.labels?.text ? parseLabelsFile(g.labels.text).labels : [];
      sessions.push({
        id, createdAt: c.createdAt, transcript: c.transcript, words: c.words, samples: c.samples,
        labels: labelsFor(c.words, lab), wav: g.wav?.blob, viewport: c.viewport,
        ...sessionEvents(c),
      });
    } catch (e) {
      errors.push(`${id}: ${(e as Error).message}`);
    }
  }
  sessions.sort((a, b) => a.id.localeCompare(b.id));
  return { sessions, errors };
}

/** Next free `Uxx` id. */
export function nextSessionId(existing: readonly string[]): string {
  let max = 0;
  for (const id of existing) {
    const m = /^U(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `U${String(max + 1).padStart(2, "0")}`;
}
