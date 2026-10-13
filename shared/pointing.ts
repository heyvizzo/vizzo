// Pointing resolution (ARCHITECTURE §6). Pure functions, shared by the server and the cursor lab.
import type { CursorRest, CursorSample, ElementRef, PageClick, PageEvents, PointingTarget, Word } from "./protocol.ts";

/** @deprecated English only; use POINTING_LEXICON / isPointingWord. */
export const POINTING_WORDS = /^(this|that|these|those|here|there)$/i;

export type PointingLanguage = "en" | "ro";
export const POINTING_LANGUAGES: readonly PointingLanguage[] = ["en", "ro"];

/**
 * Deictic words per language, written without diacritics (matching strips them, so "această",
 * "aceasta", "ăsta" and "asta" all match). Romanian: near / far demonstratives in standard and
 * colloquial forms (incl. oblique cases) and place adverbs.
 */
export const POINTING_LEXICON: Record<PointingLanguage, ReadonlySet<string>> = {
  en: new Set(["this", "that", "these", "those", "here", "there"]),
  ro: new Set([
    // near: acesta/această/aceștia/acestea, acest/aceste, ăsta/asta/ăștia/astea (+ oblique)
    "acesta", "aceasta", "acestia", "acestea", "acest", "aceste", "acestui", "acestei", "acestor",
    "asta", "astia", "astea", "astuia", "asteia", "astora",
    // far: acela/aceea/aceia/acelea, acel/acea/acei/acele, ăla/aia/ăia/alea (+ oblique)
    "acela", "aceea", "aceia", "acelea", "acel", "acea", "acei", "acele", "acelui", "acelei", "acelor",
    "ala", "aia", "alea", "aluia", "aleia", "alora",
    // place
    "aici", "aicea", "acilea", "acolo", "acolea", "colo",
  ]),
};

/** Pointing word lists for a language setting: auto → both (people mix English terms into Romanian). */
export function languagesFor(setting: "auto" | "en" | "ro" | undefined): PointingLanguage[] {
  return setting === "en" ? ["en"] : setting === "ro" ? ["ro"] : ["en", "ro"];
}

/** Scribe/ISO language codes → "en" / "ro" / other 2-letter code ("eng" → "en", "ron"/"rum" → "ro"). */
export function normalizeLanguage(code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  const c = code.toLowerCase().split(/[-_]/)[0]!;
  if (c === "eng" || c === "en") return "en";
  if (c === "ron" || c === "rum" || c === "ro" || c === "mol") return "ro";
  return c.length === 3 ? c : c.slice(0, 2);
}

const RO_DIACRITICS = /[ăâîșşțţ]/giu;
const RO_WORDS = new Set([
  "si", "este", "sunt", "nu", "ce", "de", "la", "pe", "cu", "din", "un", "una", "o", "sa", "mai", "care", "pentru", "cum",
  "unde", "cand", "vreau", "poti", "poate", "fa", "fac", "face", "facem", "asa", "asta", "acesta", "aceasta", "aici", "acolo",
  "butonul", "pagina", "pagini", "sectiunea", "tabelul", "coloana", "titlul", "mare", "mic", "mica", "putin", "mult", "ei", "lui",
  "le", "il", "imi", "iti", "ne", "va", "ar", "am", "ai", "are", "fi", "fost", "dar", "sau", "daca", "doar", "deja", "acum",
]);
const EN_WORDS = new Set([
  "the", "is", "are", "it", "this", "that", "these", "those", "why", "what", "how", "where", "when", "make", "can", "could",
  "you", "to", "of", "and", "on", "with", "button", "page", "please", "do", "does", "be", "was", "my", "me", "i", "we",
  "bigger", "smaller", "here", "there", "change", "move", "show", "tell", "about", "for", "from", "its", "one", "a",
]);

/**
 * Guess English vs Romanian from a transcript (Scribe's realtime API returns language_code null when
 * auto-detecting). Romanian diacritics count 3, common words 1. Undefined when it's too close to call.
 */
export function detectLanguage(text: string): "en" | "ro" | undefined {
  let ro = (text.match(RO_DIACRITICS)?.length ?? 0) * 3;
  let en = 0;
  for (const raw of text.split(/[\s,.!?;:"()]+/)) {
    const w = foldWord(raw);
    if (!w) continue;
    if (RO_WORDS.has(w)) ro++;
    if (EN_WORDS.has(w)) en++;
  }
  if (ro === en) return undefined;
  return ro > en ? "ro" : "en";
}

/** Lowercase, drop diacritics and everything that isn't a letter: `"Această,"` → `"aceasta"`. */
export function foldWord(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}]/gu, "");
}

/**
 * The language whose pointing word this is (null if none). Hyphenated clitics count by their parts
 * ("ăsta-i" → "asta"). `languages` limits the lists (default: all).
 */
export function pointingLanguage(text: string, languages: readonly PointingLanguage[] = POINTING_LANGUAGES): PointingLanguage | null {
  const parts = [text, ...text.split(/[-‑]/)].map(foldWord).filter(Boolean);
  for (const lang of languages) if (parts.some((p) => POINTING_LEXICON[lang].has(p))) return lang;
  return null;
}

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

export function isPointingWord(text: string, languages: readonly PointingLanguage[] = POINTING_LANGUAGES): boolean {
  return pointingLanguage(text, languages) !== null;
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
export function resolvePointing(
  words: Word[], tAudioStart: number, samples: CursorSample[], opts: WindowOpts = DEFAULT_WINDOW,
  languages: readonly PointingLanguage[] = POINTING_LANGUAGES,
): PointingTarget[] {
  const sorted = sortByT(samples);
  const out: PointingTarget[] = [];
  let ref = 0;
  words.forEach((word, wordIndex) => {
    if (!pointingLanguage(word.text, languages)) return;
    const norm = normalizeWord(word.text);
    ref++;
    for (const [algorithm, r] of Object.entries(RESOLVERS)) {
      out.push({ word: norm, wordStart: word.start, algorithm, sample: r(word, tAudioStart, sorted, opts), ref, wordIndex });
    }
  });
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

/**
 * One pointing word, numbered so repeated words stay distinct:
 * `Pointing [2] "this" at 2.1 s → <h3> "Live queries" in "Card: Live queries" [data-source=…:36]`
 * (targets without a ref, e.g. from old fixtures, print as `Pointing: "this" → …`).
 */
export function formatPointingLine(t: PointingTarget): string {
  const head = t.ref !== undefined ? `Pointing [${t.ref}] "${t.word}" at ${t.wordStart.toFixed(1)} s` : `Pointing: "${t.word}"`;
  return `${head} → ${isEmptyRef(t.sample) ? "(nothing)" : describeRef(t.sample!)}`;
}

/** One line per pointing word for the chosen algorithm (see formatPointingLine). */
export function formatPointingContext(targets: PointingTarget[], algorithm = "dwellMode"): string {
  return targets.filter((t) => t.algorithm === algorithm).map(formatPointingLine).join("\n");
}

/**
 * The transcript rebuilt from its words with each pointing word's reference number after it (before
 * trailing punctuation): `move this [1] over there [2], and this [3] too.` Null when there are no refs.
 */
export function annotateTranscript(
  words: readonly Word[], targets: readonly PointingTarget[], rests: readonly CursorRest[] = [],
): string | null {
  const marks = new Map<number, string[]>();
  const add = (i: number, m: string) => marks.set(i, [...(marks.get(i) ?? []), m]);
  for (const t of targets) if (t.ref !== undefined && t.wordIndex !== undefined && !marks.get(t.wordIndex)?.includes(`[${t.ref}]`)) add(t.wordIndex, `[${t.ref}]`);
  for (const r of rests) if (r.wordIndex !== null) add(r.wordIndex, `[@${r.ref}]`);
  if (!marks.size) return null;
  return words.map((w, i) => {
    const m = marks.get(i);
    if (!m) return w.text;
    const p = /^(.*?)([^\p{L}\p{N}]*)$/u.exec(w.text)!;
    return `${p[1]} ${m.join(" ")}${p[2]}`;
  }).join(" ").replace(/\s+/g, " ").trim();
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

/** `"this" [3]` when the word is a numbered pointing word, else `"word"`. */
const quoteWord = (w: Word, words: readonly Word[], targets?: readonly PointingTarget[]): string => {
  const i = words.indexOf(w);
  const ref = targets?.find((t) => t.wordIndex === i && t.ref !== undefined)?.ref;
  return `${JSON.stringify(w.text.trim())}${ref !== undefined ? ` [${ref}]` : ""}`;
};

const saying = (t: number, words: Word[], tAudioStart: number | undefined, targets?: readonly PointingTarget[]): string => {
  const w = wordNear(t, words, tAudioStart);
  return w ? ` (while saying ${quoteWord(w, words, targets)})` : "";
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
export function formatPageContext(
  ev: PageEvents | null | undefined, words: Word[], tAudioStart: number | undefined, targets?: readonly PointingTarget[],
): string {
  if (!ev) return "";
  const lines = sortClicks(ev.clicks ?? []).map((c) =>
    `${clickVerb(c)}: ${describeRef(c)}${when(c.t, c.kind === "single" ? c.t : c.tEnd, tAudioStart)}${saying(c.t, words, tAudioStart, targets)}`);
  const pre = ev.preselected ? truncateText(ev.preselected.text) : "";
  if (ev.preselected && pre) lines.push(`Already highlighted when recording started: ${describeText(pre, ev.preselected)}`);
  const hs = (ev.highlights ?? []).filter((h) => truncateText(h.text)).slice(-MAX_HIGHLIGHT_LINES);
  hs.forEach((h, i) => {
    const span = relTime(h.tStart, tAudioStart);
    const made = span ? `made${when(h.tStart, h.t, tAudioStart)}` : "";
    const w = wordNear(h.t, words, tAudioStart);
    const meta = [h.via ? `by ${h.via}` : "", made, w ? `while saying ${quoteWord(w, words, targets)}` : ""].filter(Boolean).join(", ");
    lines.push(`Highlight ${i + 1}${meta ? ` (${meta.trim()})` : ""}: ${describeText(truncateText(h.text), h)}`);
  });
  return lines.join("\n");
}

// ── Cursor rests: a language-agnostic pointing signal ──────────────────────────────────────────────

/** Pointer speed (px/ms) at or below which the cursor counts as resting (≈ 80 px/s: tremor, not motion). */
export const REST_SPEED = 0.08;
/** A rest must last at least this long on one element. */
export const REST_MIN_MS = 250;
/** At most this many rests are reported (the longest, then in time order). */
export const MAX_RESTS = 6;

/** Where the cursor rested on one element while the user spoke (protocol CursorRest). */
export type { CursorRest };

export function computeRests(
  words: readonly Word[], tAudioStart: number | undefined, samples: readonly CursorSample[], targets: readonly PointingTarget[] = [],
): CursorRest[] {
  if (!words.length || tAudioStart === undefined || !Number.isFinite(tAudioStart)) return [];
  const speechFrom = tAudioStart + words[0]!.start * 1000;
  const speechTo = tAudioStart + words[words.length - 1]!.end * 1000;
  const sorted = sortByT(samples);
  const speeds = sampleSpeeds(sorted);
  const runs: { from: number; to: number; s: CursorSample }[] = [];
  let cur: { from: number; to: number; s: CursorSample } | null = null;
  sorted.forEach((s, i) => {
    const still = !(speeds[i]! > REST_SPEED); // NaN (first sample) counts as still
    const inSpeech = s.t >= speechFrom - 300 && s.t <= speechTo + 300;
    if (inSpeech && still && s.elementPath && cur && cur.s.elementPath === s.elementPath) { cur.to = s.t; return; }
    if (cur) runs.push(cur);
    cur = inSpeech && still && s.elementPath ? { from: s.t, to: s.t, s } : null;
  });
  if (cur) runs.push(cur);

  const speechMs = Math.max(1, speechTo - speechFrom);
  const covered = (r: { from: number; to: number; s: CursorSample }) => targets.some((t) => {
    if (!t.sample || t.sample.elementPath !== r.s.elementPath) return false;
    const w = tAudioStart + t.wordStart * 1000;
    return w >= r.from - 400 && w <= r.to + 400;
  });
  const kept = runs.filter((r) => r.to - r.from >= REST_MIN_MS && !covered(r))
    .sort((a, b) => (b.to - b.from) - (a.to - a.from)).slice(0, MAX_RESTS)
    .sort((a, b) => a.from - b.from);
  return kept.map((r, i) => {
    // What was being said while it rested: the rest's middle (at most 400 ms in).
    const whole = Math.min(r.to, speechTo) - Math.max(r.from, speechFrom) >= 0.9 * speechMs;
    // A cursor parked for the whole utterance isn't tied to any one word.
    const w = whole ? null : wordNear(Math.min((r.from + r.to) / 2, r.from + 400), words, tAudioStart, 600);
    return { ref: i + 1, tStart: r.from, tEnd: r.to, sample: r.s, wordIndex: w ? words.indexOf(w) : null, whole };
  });
}

/** `Cursor rested [@1] on <h3> "Embeds" in "Card: Embeds" [data-source=…] from 1.2 to 1.9 s (while saying "it")`. */
export function formatRests(rests: readonly CursorRest[], words: readonly Word[], tAudioStart: number | undefined): string {
  return rests.map((r) => {
    const w = r.wordIndex !== null ? words[r.wordIndex] : undefined;
    const span = when(r.tStart, r.tEnd, tAudioStart);
    const tail = r.whole ? " (the cursor stayed there the whole time you spoke)" : w ? ` (while saying ${JSON.stringify(w.text.trim())})` : "";
    return `Cursor rested [@${r.ref}] on ${describeRef(r.sample)}${span}${tail}`;
  }).join("\n");
}
