// Element description for cursor samples: the most specific meaningful element under the pointer
// (a card's title, not the card), its stable CSS path, own label, nearest [data-source], and the
// enclosing labeled component. Written against a minimal element interface so it runs under unit
// tests without a DOM.

export interface ElLike {
  tagName: string;
  id: string;
  parentElement: ElLike | null;
  children: ArrayLike<ElLike>;
  textContent: string | null;
  getAttribute(name: string): string | null;
}

const SAFE_ID = /^[A-Za-z_][\w-]*$/;

/** One path segment: `tag#id` when the id is CSS-safe, else `tag` plus `:nth-of-type(n)` when siblings share the tag. */
function segment(el: ElLike): string {
  const tag = el.tagName.toLowerCase();
  if (el.id && SAFE_ID.test(el.id)) return `${tag}#${el.id}`;
  const parent = el.parentElement;
  if (!parent) return tag;
  const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
  if (same.length <= 1) return tag;
  return `${tag}:nth-of-type(${same.indexOf(el) + 1})`;
}

/**
 * Stable CSS path from `root` (inclusive) down to `el`, joined with " > ". Stops early at the first
 * ancestor with a CSS-safe id (ids are unique). The result is a valid `querySelector` selector.
 * Returns null if `el` isn't inside `root` (when root is given).
 */
export function cssPath(el: ElLike, root?: ElLike | null): string | null {
  if (root && !isInside(el, root)) return null;
  const parts: string[] = [];
  let cur: ElLike | null = el;
  while (cur) {
    const seg = segment(cur);
    parts.unshift(seg);
    if (cur === root || seg.includes("#")) return parts.join(" > ");
    if (cur.tagName.toLowerCase() === "html") break;
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}

export function isInside(el: ElLike, root: ElLike): boolean {
  for (let cur: ElLike | null = el; cur; cur = cur.parentElement) if (cur === root) return true;
  return false;
}

export function closestWithAttr(el: ElLike | null, attr: string, root?: ElLike | null): ElLike | null {
  for (let cur = el; cur; cur = cur.parentElement) {
    if (cur.getAttribute(attr) !== null) return cur;
    if (cur === root) break;
  }
  return null;
}

export const LABEL_MAX = 60;

/** Trim, collapse whitespace, cap at `max` chars with an ellipsis; null when empty. */
export function cleanText(s: string | null | undefined, max = LABEL_MAX): string | null {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t ? (t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t) : null;
}

/** Simplified accessible name: aria-label, alt, title, placeholder, then text content. */
export function accessibleName(el: ElLike): string | null {
  return (
    cleanText(el.getAttribute("aria-label")) ??
    cleanText(el.getAttribute("alt")) ??
    cleanText(el.getAttribute("title")) ??
    cleanText(el.getAttribute("placeholder")) ??
    cleanText(el.textContent)
  );
}

/** Elements that are a meaningful pointing target on their own (the title, not the card around it). */
const MEANINGFUL = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6", "th", "td", "caption", "button", "a", "label", "legend",
  "input", "select", "textarea", "option", "img", "li", "dt", "dd", "p", "blockquote", "summary", "figcaption",
]);
/** Elements whose text content isn't their name (form controls, images). */
const CONTROLS = new Set(["input", "select", "textarea", "img"]);

const tagOf = (el: ElLike) => el.tagName.toLowerCase();
const hasOwnAttr = (el: ElLike, attr: string) => el.getAttribute(attr) !== null;
const visibleLen = (s: string | null) => (s ?? "").replace(/\s+/g, "").length;

/** True if the element has text of its own, not only text inside child elements (`<div>Price <b>$5</b></div>` → true). */
export function hasOwnText(el: ElLike): boolean {
  const all = visibleLen(el.textContent);
  if (!all) return false;
  let inChildren = 0;
  for (const c of Array.from(el.children)) inChildren += visibleLen(c.textContent);
  return all > inChildren;
}

/** A meaningful target: a listed tag, an element with its own data-label/data-source, or a div/span… with its own text. */
export function isMeaningful(el: ElLike): boolean {
  return MEANINGFUL.has(tagOf(el)) || hasOwnAttr(el, "data-label") || hasOwnAttr(el, "data-source") || hasOwnText(el);
}

/**
 * The most specific meaningful element at or above `el`, never walking past `root`.
 * Null if there is none (e.g. a bare wrapper with no labeled ancestor).
 */
export function meaningfulTarget(el: ElLike, root?: ElLike | null): ElLike | null {
  for (let cur: ElLike | null = el; cur; cur = cur.parentElement) {
    if (isMeaningful(cur)) return cur;
    if (cur === root) break;
  }
  return null;
}

/**
 * An element's own short label: its visible text for headings, cells, buttons, links…; its name for
 * controls and images; its data-label for components (a card, a row), never the component's whole text.
 */
export function ownLabel(el: ElLike): string | null {
  const attr = (n: string) => cleanText(el.getAttribute(n));
  const tag = tagOf(el);
  if (CONTROLS.has(tag)) return attr("aria-label") ?? attr("alt") ?? attr("data-label") ?? attr("title") ?? attr("placeholder");
  if (MEANINGFUL.has(tag) || (!hasOwnAttr(el, "data-label") && hasOwnText(el))) {
    return attr("aria-label") ?? cleanText(el.textContent) ?? attr("data-label") ?? attr("title");
  }
  return attr("data-label") ?? attr("aria-label") ?? attr("title");
}

export interface ElementInfo { elementPath: string | null; dataSource: string | null; label: string | null; container: string | null }

export const NO_ELEMENT: ElementInfo = { elementPath: null, dataSource: null, label: null, container: null };

/**
 * What a cursor sample records about the element under the pointer (ARCHITECTURE §3 CursorSample).
 * Outside `root` → all null. Otherwise:
 * - target = the most specific meaningful element at/above `el` (a card's `<h3>`, a `<th>`, a button),
 *   walking up from bare wrappers but never past `root` (none found → `el` itself);
 * - elementPath = the target's CSS path; label = `ownLabel(target)`;
 * - dataSource = the target's own data-source, else the nearest ancestor's;
 * - container = data-label of the nearest *ancestor* that has one (the card, table, form), when it
 *   differs from label; else null.
 */
export function describeElement(el: ElLike | null, root?: ElLike | null): ElementInfo {
  if (!el) return NO_ELEMENT;
  if (root && !isInside(el, root)) return NO_ELEMENT;
  const target = meaningfulTarget(el, root) ?? el;
  const elementPath = cssPath(target, root);
  if (elementPath === null) return NO_ELEMENT;
  const label = ownLabel(target);
  const src = closestWithAttr(target, "data-source", root);
  const above = target === root ? null : target.parentElement;
  const comp = above ? closestWithAttr(above, "data-label", root) : null;
  const container = cleanText(comp?.getAttribute("data-label"));
  return {
    elementPath,
    dataSource: src?.getAttribute("data-source") ?? null,
    label,
    container: container && container !== label ? container : null,
  };
}
