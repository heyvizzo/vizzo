// Pointer sampler (PRD FR8, ARCHITECTURE §3 CursorSample): ~60 Hz in rAF, element looked up at sample time.
import type { CursorSample, ElementDetails } from "../../shared/protocol.ts";
import { elementDetails } from "./details.ts";
import { describeElement, pointedElement } from "./dom.ts";

const MIN_DT_MS = 15; // cap at ~60 Hz on high-refresh displays
const KEEP_MS = 120_000;
/** Element details are re-taken this often while the pointer stays on one element (it may have moved or changed). */
const DETAILS_REFRESH_MS = 1000;

export class Sampler {
  readonly samples: CursorSample[] = [];
  private x: number | null = null;
  private y: number | null = null;
  private last = -Infinity;
  private raf = 0;
  /** Element the last details were taken for, and when. */
  private detailsPath: string | null = null;
  private detailsAt = -Infinity;
  /** While paused (replay), live pointer samples aren't recorded. */
  paused = false;
  onSample: ((s: CursorSample) => void) | null = null;
  /** Adds to an element's details as they're taken (e.g. React component info the page preload fetched). */
  decorate: ((details: ElementDetails, elementPath: string, el: Element) => void) | null = null;
  /** The element at a viewport point (default document.elementFromPoint); the page preload sees through its overlay. */
  pick: (x: number, y: number) => Element | null = (x, y) => document.elementFromPoint(x, y);

  /**
   * @param root     demo container; elements outside it record null element fields
   * @param scroller the demo's scroll container; its scrollLeft/scrollTop are recorded as scrollX/scrollY
   */
  constructor(private root: HTMLElement, private scroller: HTMLElement) {}

  start(): void {
    window.addEventListener("pointermove", this.onMove, { passive: true });
    const tick = () => {
      this.sample();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    window.removeEventListener("pointermove", this.onMove);
    cancelAnimationFrame(this.raf);
  }

  /** Take the current element's details again on the next sample (more became known about it). */
  refreshDetails(): void {
    this.detailsPath = null;
  }

  /** The pointer left the page: record nothing until it moves over it again. */
  forget(): void {
    this.x = null;
    this.y = null;
  }

  private onMove = (e: PointerEvent) => {
    this.x = e.clientX;
    this.y = e.clientY;
  };

  private sample(): void {
    if (this.paused || this.x === null || this.y === null) return;
    const t = performance.now();
    if (t - this.last < MIN_DT_MS) return;
    this.last = t;
    const el = this.pick(this.x, this.y);
    const info = describeElement(el, this.root);
    const s: CursorSample = { t, x: this.x, y: this.y, scrollX: this.scroller.scrollLeft, scrollY: this.scroller.scrollTop, ...info };
    // Details only on a new element (or every DETAILS_REFRESH_MS on the same one): computed styles cost too much per frame.
    if (info.elementPath && (info.elementPath !== this.detailsPath || t - this.detailsAt >= DETAILS_REFRESH_MS)) {
      const target = pointedElement(el, this.root);
      if (target) {
        this.attachDetails(s, target);
        this.detailsPath = info.elementPath;
        this.detailsAt = t;
      }
    }
    this.push(s);
  }

  private attachDetails(s: CursorSample, target: Element): void {
    try {
      s.details = elementDetails(target);
      this.decorate?.(s.details, s.elementPath!, target);
    } catch { /* detached mid-sample */ }
  }

  /** A sample (with details) of the element at a viewport point, and that element; null off the page's elements. */
  sampleAt(x: number, y: number): { sample: CursorSample; el: Element } | null {
    const hit = this.pick(x, y);
    const info = describeElement(hit, this.root);
    const target = pointedElement(hit, this.root);
    if (!info.elementPath || !target) return null;
    const s: CursorSample = { t: performance.now(), x, y, scrollX: this.scroller.scrollLeft, scrollY: this.scroller.scrollTop, ...info };
    this.attachDetails(s, target);
    return { sample: s, el: target };
  }

  private push(s: CursorSample): void {
    this.samples.push(s);
    if (this.samples.length > 8000 && s.t - this.samples[0]!.t > KEEP_MS) {
      const cut = this.samples.findIndex((x) => s.t - x.t <= KEEP_MS);
      this.samples.splice(0, cut);
    }
    this.onSample?.(s);
  }

  /** Samples with from ≤ t ≤ to. */
  range(from: number, to = Infinity): CursorSample[] {
    return this.samples.filter((s) => s.t >= from && s.t <= to);
  }
}
