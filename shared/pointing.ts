// Pointing resolution (ARCHITECTURE §6). Pure functions, shared by the server and the cursor lab.
import type { CursorSample, ElementRef, PageClick, PageEvents, PointingTarget, Word } from "./protocol.ts";

export const POINTING_WORDS = /^(this|that|these|those|here|there)$/i;

export type Resolver = (word: Word, tAudioStart: number, samples: CursorSample[], opts?: WindowOpts) => CursorSample | null;
export interface WindowOpts { preMs: number; postMs: number }

export const DEFAULT_WINDOW: WindowOpts = { preMs: 300, postMs: 200 };

/**
 * dwellMode tie tolerance, in px/ms (0.05 px/ms = 50 px/s). Samples whose speed is within this
 * of the window's minimum speed count as "tied" for the slowest sample. 50 px/s is well below
 * deliberate pointer motion (hundreds of px/s) and absorbs hand tremor / sub-pixel jitter.
 */
export const DWELL_TIE_EPS = 0.05;

/** Lowercase and strip everything that isn't a letter: `"This,"` → `"this"`. */
export function normalizeWord(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}]/gu, "");
}

export function isPointingWord(text: string): boolean {
  return POINTING_WORDS.test(normalizeWord(text));
}

/** Absolute client times for a word and its resolver window. */
export function wordWindow(word: Word, tAudioStart: number, opts: WindowOpts = DEFAULT_WINDOW) {
  const tStart = tAudioStart + word.start * 1000;
  const tEnd = tAudioStart + word.end * 1000;
  return { tStart, tEnd, from: tStart - opts.preMs, to: tEnd + opts.postMs };
}

/**
 * Speed of every sample relative to its previous sample, in px/ms of viewport pointer motion
 * (x/y; scrolling doesn't count as hand motion). The first sample and samples with dt ≤ 0 get NaN.
 * `samples` must be sorted by t.
 */
export function sampleSpeeds(samples: readonly CursorSample[]): number[] {
  return samples.map((s, i) => {
    const p = samples[i - 1];
    if (!p) return NaN;
    const dt = s.t - p.t;
    if (!(dt > 0)) return NaN;
    return Math.hypot(s.x - p.x, s.y - p.y) / dt;
  });
}

function sortByT(samples: readonly CursorSample[]): CursorSample[] {
  for (let i = 1; i < samples.length; i++) if (samples[i]!.t < samples[i - 1]!.t) return [...samples].sort((a, b) => a.t - b.t);
  return samples as CursorSample[];
}

interface Indexed { s: CursorSample; speed: number }

/** Window samples paired with their speed (relative to the previous sample in the full trail). */
function windowed(word: Word, tAudioStart: number, samples: CursorSample[], opts?: WindowOpts) {
  const sorted = sortByT(samples);
  const speeds = sampleSpeeds(sorted);
  const w = wordWindow(word, tAudioStart, opts ?? DEFAULT_WINDOW);
  const inWin: Indexed[] = [];
  sorted.forEach((s, i) => {
    if (s.t >= w.from && s.t <= w.to) inWin.push({ s, speed: speeds[i]! });
  });
  return { w, inWin };
}

/** Of `cands`, the one closest in time to `t` (earlier wins an exact tie). */
function closestTo<T extends { s: CursorSample }>(cands: T[], t: number): T | null {
  let best: T | null = null;
  for (const c of cands) if (!best || Math.abs(c.s.t - t) < Math.abs(best.s.t - t)) best = c;
  return best;
}

/** Most frequent non-null elementPath in the window; ties go to the element seen closest to the word start. */
function modeElement(inWin: Indexed[], tStart: number): string | null {
  const counts = new Map<string, { n: number; dist: number }>();
  for (const { s } of inWin) {
    if (s.elementPath === null) continue;
    const c = counts.get(s.elementPath) ?? { n: 0, dist: Infinity };
    c.n++;
    c.dist = Math.min(c.dist, Math.abs(s.t - tStart));
    counts.set(s.elementPath, c);
  }
  let best: string | null = null;
  let bc = { n: 0, dist: Infinity };
  for (const [path, c] of counts) if (c.n > bc.n || (c.n === bc.n && c.dist < bc.dist)) [best, bc] = [path, c];
  return best;
}

/** Sample closest to the word's start time (whole trail, no window). */
export const atStart: Resolver = (word, tAudioStart, samples) => {
  const t = tAudioStart + word.start * 1000;
  return closestTo(samples.map((s) => ({ s })), t)?.s ?? null;
};

/** Slowest sample in the window (exact speed ties → closest to word start). */
export const dwell: Resolver = (word, tAudioStart, samples, opts) => {
  const { w, inWin } = windowed(word, tAudioStart, samples, opts);
  const valid = inWin.filter((c) => !Number.isNaN(c.speed));
  if (!valid.length) return closestTo(inWin, w.tStart)?.s ?? null;
  const min = Math.min(...valid.map((c) => c.speed));
  return closestTo(valid.filter((c) => c.speed === min), w.tStart)!.s;
};

/** A sample on the most frequent element in the window (the one closest to word start). */
export const mode: Resolver = (word, tAudioStart, samples, opts) => {
  const { w, inWin } = windowed(word, tAudioStart, samples, opts);
  const el = modeElement(inWin, w.tStart);
  if (el === null) return null;
  return closestTo(inWin.filter((c) => c.s.elementPath === el), w.tStart)!.s;
};

/**
 * dwell, with ties broken toward the mode element. "Tied" = speed ≤ minSpeed + DWELL_TIE_EPS.
 * Among tied samples: prefer those on the mode element, then the one closest to word start.
 */
export const dwellMode: Resolver = (word, tAudioStart, samples, opts) => {
  const { w, inWin } = windowed(word, tAudioStart, samples, opts);
  const valid = inWin.filter((c) => !Number.isNaN(c.speed));
  if (!valid.length) return closestTo(inWin, w.tStart)?.s ?? null;
  const min = Math.min(...valid.map((c) => c.speed));
  const tied = valid.filter((c) => c.speed <= min + DWELL_TIE_EPS);
  const el = modeElement(inWin, w.tStart);
  const onMode = tied.filter((c) => el !== null && c.s.elementPath === el);
  return closestTo(onMode.length ? onMode : tied, w.tStart)!.s;
};

export const RESOLVERS: Record<string, Resolver> = { atStart, dwell, mode, dwellMode };
export const ALGORITHMS = Object.keys(RESOLVERS);

/**
 * Run every resolver on every pointing word. Output order: word order, then ALGORITHMS order.
 * `word` is the normalized word ("this"); `wordStart` is word.start (seconds from turn audio start).
 */
export function resolvePointing(words: Word[], tAudioStart: number, samples: CursorSample[], opts: WindowOpts = DEFAULT_WINDOW): PointingTarget[] {
  const sorted = sortByT(samples);
  const out: PointingTarget[] = [];
  for (const word of words) {
    const norm = normalizeWord(word.text);
    if (!POINTING_WORDS.test(norm)) continue;
    for (const [algorithm, r] of Object.entries(RESOLVERS)) {
      out.push({ word: norm, wordStart: word.start, algorithm, sample: r(word, tAudioStart, sorted, opts) });
    }
  }
  return out;
}

/** `"main > section:nth-of-type(2) > button#cta.primary"` → `"button"`. */
export function tagFromPath(path: string | null): string | null {
  if (!path) return null;
  const last = path.split(">").pop()!.trim();
  const m = /^[a-zA-Z][\w-]*/.exec(last);
  return m ? m[0].toLowerCase() : null;
}

const isEmptyRef = (r: ElementRef | null | undefined): boolean => !r || (!r.elementPath && !r.dataSource && !r.label);

/**
 * `<h3> "Live queries" in "Card: Live queries" [data-source=web/cursor/demo/demo.html:36]`. Missing
 * parts are omitted; `in "…"` only when the container differs from the label. "" for an empty ref.
 */
export function describeRef(r: ElementRef, opts: { label?: boolean } = {}): string {
  const parts: string[] = [];
  const tag = tagFromPath(r.elementPath);
  if (tag) parts.push(`<${tag}>`);
  if (r.label && opts.label !== false) parts.push(JSON.stringify(r.label));
  if (r.container && r.container !== r.label) parts.push(`in ${JSON.stringify(r.container)}`);
  if (r.dataSource) parts.push(`[data-source=${r.dataSource}]`);
  return parts.join(" ");
}

/** One line per pointing word for the chosen algorithm, e.g.
 * `Pointing: "this" → <h3> "Live queries" in "Card: Live queries" [data-source=web/cursor/demo/demo.html:36]` */
export function formatPointingContext(targets: PointingTarget[], algorithm = "dwellMode"): string {
  return targets
    .filter((t) => t.algorithm === algorithm)
    .map((t) => `Pointing: "${t.word}" → ${isEmptyRef(t.sample) ? "(nothing)" : describeRef(t.sample!)}`)
    .join("\n");
}

/** At most this many click lines (the latest events). */
export const MAX_CLICK_LINES = 8;
/** At most this many highlight lines (the latest ones). */
export const MAX_HIGHLIGHT_LINES = 6;
/** A click further than this from every word's span isn't attributed to a word. */
export const CLICK_WORD_MAX_MS = 1000;
/** Selected text is cut to this many characters in the context. */
export const SELECTION_MAX = 200;

/** Click events sorted by time, empty refs dropped, the latest `max` kept. (Grouping into double/triple/multi happens in the recorder.) */
export function sortClicks(clicks: readonly PageClick[], max = MAX_CLICK_LINES): PageClick[] {
  return [...clicks].filter((c) => !isEmptyRef(c)).sort((a, b) => a.t - b.t).slice(-max);
}

/** "Clicked", "Double-clicked", "Triple-clicked", "Clicked 5 times". */
export function clickVerb(c: Pick<PageClick, "kind" | "count">): string {
  switch (c.kind) {
    case "single": return "Clicked";
    case "double": return "Double-clicked";
    case "triple": return "Triple-clicked";
    default: return `Clicked ${c.count} times`;
  }
}

/** Client time → seconds from the turn's first audio sample, e.g. "1.4 s" (negative: before speaking). Null without tAudioStart. */
export function relTime(t: number, tAudioStart: number | undefined): string | null {
  if (tAudioStart === undefined || !Number.isFinite(tAudioStart) || !Number.isFinite(t)) return null;
  const s = (t - tAudioStart) / 1000;
  return `${(Math.round(s * 10) / 10).toFixed(1)} s`;
}

/** " at 1.4 s" or " from 1.0 to 2.3 s" ("" without tAudioStart). */
function when(from: number, to: number, tAudioStart: number | undefined): string {
  const a = relTime(from, tAudioStart);
  if (!a) return "";
  const b = relTime(to, tAudioStart)!;
  return a === b ? ` at ${a}` : ` from ${a.replace(" s", "")} to ${b}`;
}

/**
 * The word whose span [tAudioStart + start·1000, tAudioStart + end·1000] is nearest client time `t`
 * (0 inside the span; ties → the earlier word), if within `maxMs`. Null without words/tAudioStart.
 */
export function wordNear(t: number, words: readonly Word[] | undefined, tAudioStart: number | undefined, maxMs = CLICK_WORD_MAX_MS): Word | null {
  if (!words?.length || tAudioStart === undefined || !Number.isFinite(tAudioStart)) return null;
  let best: Word | null = null;
  let bestD = Infinity;
  for (const w of words) {
    const from = tAudioStart + w.start * 1000;
    const to = tAudioStart + w.end * 1000;
    const d = t < from ? from - t : t > to ? t - to : 0;
    if (d < bestD) [best, bestD] = [w, d];
  }
  return bestD <= maxMs ? best : null;
}

/** Collapse whitespace and cut to `max` chars with an ellipsis. */
export function truncateText(text: string, max = SELECTION_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

const norm = (s: string) => s.replace(/…$/, "").replace(/\s+/g, " ").trim().toLowerCase();

/** `"text" in <p> in "Card: …" [data-source=…]` (the element's label is left out when it just repeats the text). */
function describeText(text: string, ref: ElementRef): string {
  const label = ref.label ? norm(ref.label) : "";
  const repeats = !!label && (norm(text).includes(label) || label.includes(norm(text)));
  const where = describeRef(ref, { label: !repeats });
  return `${JSON.stringify(text)}${where ? ` in ${where}` : ""}`;
}

const saying = (t: number, words: Word[], tAudioStart: number | undefined): string => {
  const w = wordNear(t, words, tAudioStart);
  return w ? ` (while saying ${JSON.stringify(w.text.trim())})` : "";
};

/**
 * What the user did on the page during the turn, as lines for the LLM context ("" if nothing). Times are
 * seconds from the first audio sample (the words' clock):
 *   `Clicked: <th> "Price / month" in "Pricing table" [data-source=…] at 1.4 s (while saying "this")`
 *   `Double-clicked: <h3> "Live queries" … at 2.1 s` · `Triple-clicked: …` · `Clicked 5 times: <button> … from 1.0 to 2.3 s`
 *   `Already highlighted when recording started: "…" in <p> …`
 *   `Highlight 1 (made from 0.8 to 1.6 s, while saying "these"): "…" in <td> …`
 * Clicks: sorted by time, the latest MAX_CLICK_LINES; the word nearest the first click (CLICK_WORD_MAX_MS).
 * Highlights: in order, the latest MAX_HIGHLIGHT_LINES, numbered; the word nearest the highlight's end.
 */
export function formatPageContext(ev: PageEvents | null | undefined, words: Word[], tAudioStart: number | undefined): string {
  if (!ev) return "";
  const lines = sortClicks(ev.clicks ?? []).map((c) =>
    `${clickVerb(c)}: ${describeRef(c)}${when(c.t, c.kind === "single" ? c.t : c.tEnd, tAudioStart)}${saying(c.t, words, tAudioStart)}`);
  const pre = ev.preselected ? truncateText(ev.preselected.text) : "";
  if (ev.preselected && pre) lines.push(`Already highlighted when recording started: ${describeText(pre, ev.preselected)}`);
  const hs = (ev.highlights ?? []).filter((h) => truncateText(h.text)).slice(-MAX_HIGHLIGHT_LINES);
  hs.forEach((h, i) => {
    const span = relTime(h.tStart, tAudioStart);
    const made = span ? `made${when(h.tStart, h.t, tAudioStart)}` : "";
    const w = wordNear(h.t, words, tAudioStart);
    const meta = [h.via ? `by ${h.via}` : "", made, w ? `while saying ${JSON.stringify(w.text.trim())}` : ""].filter(Boolean).join(", ");
    lines.push(`Highlight ${i + 1}${meta ? ` (${meta.trim()})` : ""}: ${describeText(truncateText(h.text), h)}`);
  });
  return lines.join("\n");
}
