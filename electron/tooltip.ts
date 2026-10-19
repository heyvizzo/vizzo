// Hover tooltips for the browser pane (the app's own views use Chromium's native `title` tooltip). This preload-side
// tracker reads the hovered element's tip and asks main.ts to draw it in the tooltip view (shell/tooltip.html),
// which sits above every other view and so isn't clipped by a short toolbar. Exactly one tooltip shows: the overlay's
// own elements carry `data-tip` (no `title`), and a page element's `title` is taken off while it's hovered (put back
// when the tooltip goes), so Chromium has none to draw on top of ours.
import { ipcRenderer } from "electron";

/** Hover this long before the first tooltip shows. */
const DELAY_MS = 600;
/** Within this long of a tooltip hiding, the next one shows at once (sweeping along a row of buttons). */
const WARM_MS = 500;

export interface TooltipRequest { text: string; x: number; y: number; width: number; height: number }

/**
 * Tracks the pointer and shows the nearest `title` under it. `inner` resolves events from a closed shadow root,
 * whose elements the event path hides: given the host and the point, it returns the element inside.
 */
export function installTooltips(inner?: (host: Element, x: number, y: number) => Element | null): void {
  let current: Element | null = null;
  /** The text for `current`: its `data-tip`, or the `title` taken off it. */
  let text = "";
  /** The page element whose `title` is off while it's hovered, and that title. */
  let stashed: { el: Element; title: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let shown = false;
  let lastHidden = -Infinity;

  /** The element whose tip to show: inside the overlay (via `inner`), the nearest `data-tip`; on the page, the nearest `title`. */
  const tipped = (e: MouseEvent): Element | null => {
    for (const n of e.composedPath()) {
      if (!(n instanceof Element)) continue;
      const hit = inner?.(n, e.clientX, e.clientY);
      if (hit) {
        const el = hit.closest("[data-tip]");
        return el?.getAttribute("data-tip")?.trim() ? el : null;
      }
      const el = n.closest("[title]");
      if (el?.getAttribute("title")?.trim()) return el;
    }
    return null;
  };
  const restore = () => {
    if (!stashed) return;
    const { el, title } = stashed;
    stashed = null;
    if (!el.hasAttribute("title")) el.setAttribute("title", title); // unless the page set a new one meanwhile
  };
  const hide = () => {
    clearTimeout(timer);
    current = null;
    restore();
    if (!shown) return;
    shown = false;
    lastHidden = performance.now();
    ipcRenderer.send("tooltip:hide");
  };
  const show = () => {
    if (current?.hasAttribute("data-tip")) text = current.getAttribute("data-tip")?.trim() ?? ""; // it may have changed
    if (!current?.isConnected || !text) return;
    const r = current.getBoundingClientRect();
    shown = true;
    ipcRenderer.send("tooltip:show", { text, x: r.left, y: r.top, width: r.width, height: r.height } satisfies TooltipRequest);
  };

  const track = (e: MouseEvent) => {
    let el = tipped(e);
    // Still on the page element whose title is off (it no longer matches [title]), unless a titled child took over.
    if (stashed && e.composedPath().includes(stashed.el) && (!el || el.contains(stashed.el))) el = stashed.el;
    if (el === current) return;
    hide();
    if (!el) return;
    current = el;
    if (el.hasAttribute("data-tip")) text = el.getAttribute("data-tip")!.trim();
    else {
      text = el.getAttribute("title")!.trim();
      stashed = { el, title: el.getAttribute("title")! };
      el.removeAttribute("title");
    }
    timer = setTimeout(show, performance.now() - lastHidden < WARM_MS ? 0 : DELAY_MS);
  };
  addEventListener("mouseover", track, true);
  // A closed shadow root reports one target for its whole tree: follow the pointer inside it.
  if (inner) addEventListener("mousemove", track, true);
  document.addEventListener("mouseleave", hide);
  // Leaving the pane (for the sidebar or the toolbar) ends a pending tooltip too, so it can't show up over them.
  addEventListener("mouseout", (e) => { if (!e.relatedTarget) hide(); }, true);
  addEventListener("pagehide", restore);
  for (const ev of ["mousedown", "keydown", "wheel", "blur"] as const) addEventListener(ev, hide, true);
}
