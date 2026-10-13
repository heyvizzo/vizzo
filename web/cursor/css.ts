// Scope a standalone page's stylesheet to the container it's injected into.

/**
 * Wraps `css` in `@scope (<root>) { … }` and rewrites `html`, `body` and `:root` selectors to
 * `:scope`, so the demo page's global rules apply to its container instead of the lab page.
 * Only touches tokens that look like selectors (not inside property values like `font: body`… rare).
 */
export function scopeCss(css: string, root: string): string {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // Rewrite selector-position tokens: only text before a "{" (between "}"/";"/start and "{").
  const rewritten = noComments.replace(/(?<=^|[{};])([^{};]*)\{/g, (_m, sel: string) => {
    if (sel.trim().startsWith("@")) return `${sel}{`;
    const s = sel
      .replace(/(?<![\w-]):root(?![\w-])|(?<![\w.#:-])(?:html|body)(?![\w-])/g, ":scope")
      .replace(/:scope(?:\s*>?\s*:scope)+/g, ":scope");
    return `${s}{`;
  });
  return `@scope (${root}) {\n${rewritten}\n}`;
}
