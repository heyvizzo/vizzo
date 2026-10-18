// Hover tooltips for the browser pane (the app's own views use Chromium's native `title` tooltip). This preload-side
// tracker reads the hovered element's `title` and asks main.ts to draw it in the tooltip view (shell/tooltip.html),
// which sits above every other view and so isn't clipped by a short toolbar.
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  let shown = false;
  let lastHidden = -Infinity;

  const titled = (e: MouseEvent): Element | null => {
    for (const n of e.composedPath()) {
      if (!(n instanceof Element)) continue;
      const hit = inner?.(n, e.clientX, e.clientY);
      const el = (hit ?? n).closest("[title]");
      if (el?.getAttribute("title")?.trim()) return el;
      if (hit) return null;
    }
    return null;
  };
  const hide = () => {
    clearTimeout(timer);
    current = null;
    if (!shown) return;
    shown = false;
    lastHidden = performance.now();
    ipcRenderer.send("tooltip:hide");
  };
  const show = () => {
    const text = current?.isConnected ? current.getAttribute("title")?.trim() : "";
    if (!current || !text) return;
    const r = current.getBoundingClientRect();
    shown = true;
    ipcRenderer.send("tooltip:show", { text, x: r.left, y: r.top, width: r.width, height: r.height } satisfies TooltipRequest);
  };

  const track = (e: MouseEvent) => {
    const el = titled(e);
    if (el === current) return;
    hide();
    if (!el) return;
    current = el;
    timer = setTimeout(show, performance.now() - lastHidden < WARM_MS ? 0 : DELAY_MS);
  };
  addEventListener("mouseover", track, true);
  // A closed shadow root reports one target for its whole tree: follow the pointer inside it.
  if (inner) addEventListener("mousemove", track, true);
  document.addEventListener("mouseleave", hide);
  for (const ev of ["mousedown", "keydown", "wheel", "blur"] as const) addEventListener(ev, hide, true);
}
