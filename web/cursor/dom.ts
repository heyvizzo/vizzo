// Element description for cursor samples: stable CSS path, closest [data-source], label.
// Written against a minimal element interface so it runs under unit tests without a DOM.

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

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t ? (t.length > 80 ? t.slice(0, 79) + "…" : t) : null;
};

/** Simplified accessible name: aria-label, alt, title, placeholder, then text content. */
export function accessibleName(el: ElLike): string | null {
  return (
    clean(el.getAttribute("aria-label")) ??
    clean(el.getAttribute("alt")) ??
    clean(el.getAttribute("title")) ??
    clean(el.getAttribute("placeholder")) ??
    clean(el.textContent)
  );
}

export interface ElementInfo { elementPath: string | null; dataSource: string | null; label: string | null }

export const NO_ELEMENT: ElementInfo = { elementPath: null, dataSource: null, label: null };

/**
 * What a cursor sample records about the element under the pointer (ARCHITECTURE §3 CursorSample).
 * Outside `root` → all null. label = closest [data-label], else the accessible name of the closest
 * [data-source] element (or of `el` itself).
 */
export function describeElement(el: ElLike | null, root?: ElLike | null): ElementInfo {
  if (!el) return NO_ELEMENT;
  const elementPath = cssPath(el, root);
  if (elementPath === null) return NO_ELEMENT;
  const src = closestWithAttr(el, "data-source", root);
  const lab = closestWithAttr(el, "data-label", root);
  return {
    elementPath,
    dataSource: src?.getAttribute("data-source") ?? null,
    label: clean(lab?.getAttribute("data-label")) ?? accessibleName(src ?? el),
  };
}
