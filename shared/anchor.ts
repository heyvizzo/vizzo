// Element threads: which element a turn is about (its anchor), and whether an existing thread is on that element.
// Contract for docs/PLAN-threads.md. Unit tested in anchor.test.ts.
import { tagFromPath } from "./pointing.ts";
import type { CursorRest, CursorSample, ElementDetails, PageClick, PointingTarget, Word } from "./protocol.ts";
import { normalizePageUrl, type ThreadAnchor, type ThreadInfo } from "./threads.ts";

export interface AnchorInput {
  words: Word[];
  /** Resolved pointing targets of the turn (TurnBase.pointing). */
  pointing: PointingTarget[];
  /** Cursor rests of the turn (TurnBase.rests). */
  rests: CursorRest[];
  /** All cursor samples of the turn (fallback: the last sample with an element). */
  samples: CursorSample[];
  /** The browser pane's URL (normalized inside). */
  pageUrl: string;
  /** Clicks during the turn. When given, the last click on an element is the anchor (queued turns: where you clicked). */
  clicks?: PageClick[];
}

/** A click as a cursor sample at the click's spot; scroll comes from the sample nearest the click (0 without one). */
function clickSample(c: PageClick, samples: readonly CursorSample[]): CursorSample {
  let near: CursorSample | undefined;
  for (const s of samples) if (!near || Math.abs(s.t - c.t) < Math.abs(near.t - c.t)) near = s;
  return {
    t: c.t, x: c.x, y: c.y, scrollX: near?.scrollX ?? 0, scrollY: near?.scrollY ?? 0,
    elementPath: c.elementPath, dataSource: c.dataSource, label: c.label, ...(c.container !== undefined ? { container: c.container } : {}),
  };
}

/** Same order as the prompt formatter's (claude.ts formatPointingForPrompt): the best algorithm's pick per word. */
const ALGO_PREFERENCE = ["dwellMode", "dwell", "mode", "atStart"];
const algoRank = (a: string): number => { const i = ALGO_PREFERENCE.indexOf(a); return i < 0 ? ALGO_PREFERENCE.length : i; };

/** The sample the turn is about (see inferAnchor), or null. */
function dominantSample(input: AnchorInput): CursorSample | null {
  const clicked = (input.clicks ?? []).filter((c) => c.elementPath).sort((a, b) => a.t - b.t);
  if (clicked.length) return clickSample(clicked[clicked.length - 1]!, input.samples);
  const rests = input.rests.filter((r) => r.sample.elementPath);
  const whole = rests.find((r) => r.whole);
  if (whole) return whole.sample;
  if (rests.length) return [...rests].sort((a, b) => (b.tEnd - b.tStart) - (a.tEnd - a.tStart))[0]!.sample;
  const pointed = input.pointing.filter((t) => t.sample?.elementPath)
    .sort((a, b) => a.wordStart - b.wordStart || algoRank(a.algorithm) - algoRank(b.algorithm));
  if (pointed.length) return pointed[0]!.sample;
  for (let i = input.samples.length - 1; i >= 0; i--) if (input.samples[i]!.elementPath) return input.samples[i]!;
  return null;
}

/** Only a turn's first sample per element carries details: find them on another sample on the same element. */
function detailsFor(s: CursorSample, input: AnchorInput): { details: ElementDetails; at: CursorSample } | null {
  if (s.details) return { details: s.details, at: s };
  const pool = [...input.samples, ...input.rests.map((r) => r.sample), ...input.pointing.flatMap((t) => (t.sample ? [t.sample] : []))];
  const hit = pool.find((o) => o.details && o.elementPath === s.elementPath);
  return hit ? { details: hit.details!, at: hit } : null;
}

/**
 * The turn's dominant element: the last click (when clicks are given), else the rest that covers the whole utterance, else the longest rest, else the first
 * pointing target's sample, else the last sample on an element. Null when the user pointed at nothing.
 */
export function inferAnchor(input: AnchorInput): ThreadAnchor | null {
  const s = dominantSample(input);
  if (!s?.elementPath) return null;
  const found = detailsFor(s, input);
  const d = found?.details;
  const at = found?.at ?? s;
  return {
    pageUrl: normalizePageUrl(input.pageUrl),
    selector: d?.selector ?? s.elementPath,
    domPath: d?.domPath ?? s.elementPath,
    dataSource: s.dataSource ?? null,
    label: s.label ?? null,
    text: d?.text ?? null,
    role: d?.attrs.role ?? null,
    tag: d?.tag ?? tagFromPath(s.elementPath) ?? "element",
    // Document coordinates; without details, a point at the cursor.
    bounds: d
      ? { x: d.bounds.x + at.scrollX, y: d.bounds.y + at.scrollY, width: d.bounds.width, height: d.bounds.height }
      : { x: s.x + s.scrollX, y: s.y + s.scrollY, width: 0, height: 0 },
    point: { x: s.x + s.scrollX, y: s.y + s.scrollY },
  };
}

/**
 * How strongly a thread's anchor is the same element: 3 domPath, 2 selector + text, 1 dataSource (same tag, and
 * no differing text, so two buttons under one [data-source] stay apart), 0 not the same.
 */
function matchStrength(a: ThreadAnchor, b: ThreadAnchor): number {
  if (a.domPath && a.domPath === b.domPath) return 3;
  if (a.selector && a.selector === b.selector && a.text === b.text) return 2;
  if (a.dataSource && a.dataSource === b.dataSource && a.tag === b.tag && (a.text === null || b.text === null || a.text === b.text)) return 1;
  return 0;
}

/** The thread whose anchor is the same element (same page; dataSource, domPath or selector + text match), or null. */
export function matchAnchor(anchor: ThreadAnchor, threads: readonly ThreadInfo[]): string | null {
  const page = normalizePageUrl(anchor.pageUrl);
  let best: { id: string; strength: number; at: number } | null = null;
  for (const t of threads) {
    if (normalizePageUrl(t.anchor.pageUrl) !== page) continue;
    const strength = matchStrength(anchor, t.anchor);
    if (!strength) continue;
    // The strongest match wins; on ties, the most recently interacted thread.
    if (!best || strength > best.strength || (strength === best.strength && t.lastInteractionAt > best.at)) {
      best = { id: t.threadId, strength, at: t.lastInteractionAt };
    }
  }
  return best?.id ?? null;
}

// ── Titles ──────────────────────────────────────────────────────────────────

const ROLE_NOUN: Record<string, string> = {
  button: "button", link: "link", img: "image", heading: "heading", navigation: "navigation", banner: "header",
  contentinfo: "footer", textbox: "field", searchbox: "search box", checkbox: "checkbox", radio: "option", tab: "tab",
  menuitem: "menu item", listitem: "item", list: "list", dialog: "dialog", combobox: "dropdown", switch: "switch",
  slider: "slider", table: "table", form: "form", region: "section", alert: "alert",
};
const TAG_NOUN: Record<string, string> = {
  button: "button", a: "link", img: "image", svg: "icon", picture: "image", video: "video", h1: "heading", h2: "heading",
  h3: "heading", h4: "heading", h5: "heading", h6: "heading", p: "paragraph", input: "field", textarea: "text box",
  select: "dropdown", label: "label", nav: "navigation", header: "header", footer: "footer", main: "main content",
  aside: "sidebar", section: "section", article: "card", form: "form", table: "table", tr: "row", td: "cell",
  th: "column header", ul: "list", ol: "list", li: "item", figure: "figure", blockquote: "quote", code: "code",
  pre: "code block", span: "text", strong: "text", em: "text", small: "text",
};
/** Regions named by their noun alone ("the footer"), whatever their text. */
const LANDMARKS = new Set(["navigation", "header", "footer", "sidebar", "main content"]);
const MAX_NAME = 24;

/** First words of a name, up to MAX_NAME characters (with an ellipsis when cut). */
function shortName(s: string): string {
  const t = s.replace(/\s+/g, " ").trim().replace(/^["'“‘]+|["'”’]+$/g, "");
  if (t.length <= MAX_NAME) return t;
  const cut = t.slice(0, MAX_NAME);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > 8 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–-]+$/, "")}…`;
}

/** Short spoken name for an anchor: "the red button", "the footer links" (from label / text / role / tag). */
export function anchorTitle(anchor: ThreadAnchor): string {
  const noun = (anchor.role && ROLE_NOUN[anchor.role.toLowerCase()]) || TAG_NOUN[anchor.tag.toLowerCase()] || null;
  if (noun && LANDMARKS.has(noun)) return `the ${noun}`;
  const name = (anchor.label?.trim() || anchor.text?.trim() || "");
  if (!name) return noun ? `the ${noun}` : `the ${anchor.tag.toLowerCase() || "element"} element`;
  const n = shortName(name);
  // A label that already says what it is ("Card: Embeds", "Pricing section") needs no noun.
  if (!noun) return `the '${n}' element`;
  if (new RegExp(`\\b${noun}\\b`, "i").test(n)) return `the '${n}'`;
  return `the '${n}' ${noun}`;
}
