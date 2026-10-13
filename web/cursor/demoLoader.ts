// Renders the demo page (web/cursor/demo/demo.html, built by T6) inside the cursor lab's own document
// (no iframe), so elementFromPoint and the sampler see it directly. Falls back to a built-in page.
import { scopeCss } from "./css.ts";
import { FALLBACK_DEMO_CSS, FALLBACK_DEMO_HTML } from "./fallbackDemo.ts";

// Globs compile whether or not the files exist yet.
const htmlFiles = import.meta.glob<string>("./demo/*.html", { query: "?raw", import: "default", eager: true });
const cssFiles = import.meta.glob<string>("./demo/*.css", { query: "?raw", import: "default", eager: true });
const scripts = import.meta.glob("./demo/demo.ts");

export interface DemoInfo { source: "demo" | "fallback" }

/** Injects the demo's body + scoped CSS into `root` (which needs an id), then runs demo.ts if present. */
export async function mountDemo(root: HTMLElement): Promise<DemoInfo> {
  const html = htmlFiles["./demo/demo.html"];
  const sel = `#${root.id}`;
  const style = document.createElement("style");
  style.dataset.demo = "";
  if (!html) {
    style.textContent = scopeCss(FALLBACK_DEMO_CSS, sel);
    document.head.append(style);
    root.innerHTML = FALLBACK_DEMO_HTML;
    return { source: "fallback" };
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Inline <style> blocks + every demo/*.css (linked stylesheets can't load from a raw import).
  const css = [...doc.querySelectorAll("style")].map((s) => s.textContent ?? "").concat(Object.values(cssFiles)).join("\n");
  doc.querySelectorAll("script, link[rel=stylesheet], style").forEach((n) => n.remove());
  style.textContent = scopeCss(css, sel);
  document.head.append(style);
  root.innerHTML = doc.body.innerHTML;
  root.classList.add(...doc.body.classList); // so `body.foo` rules (rewritten to `:scope.foo`) still match
  const run = scripts["./demo/demo.ts"];
  if (run) {
    try {
      await run();
    } catch (e) {
      console.warn("[cursor] demo.ts failed", e);
    }
  }
  return { source: "demo" };
}
