// Pointer sampler (PRD FR8, ARCHITECTURE §3 CursorSample): ~60 Hz in rAF, element looked up at sample time.
import type { CursorSample } from "../../shared/protocol.ts";
import { describeElement } from "./dom.ts";

const MIN_DT_MS = 15; // cap at ~60 Hz on high-refresh displays
const KEEP_MS = 120_000;

export class Sampler {
  readonly samples: CursorSample[] = [];
  private x: number | null = null;
  private y: number | null = null;
  private last = -Infinity;
  private raf = 0;
  /** While paused (replay), live pointer samples aren't recorded. */
  paused = false;
  onSample: ((s: CursorSample) => void) | null = null;

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

  private onMove = (e: PointerEvent) => {
    this.x = e.clientX;
    this.y = e.clientY;
  };

  private sample(): void {
    if (this.paused || this.x === null || this.y === null) return;
    const t = performance.now();
    if (t - this.last < MIN_DT_MS) return;
    this.last = t;
    const el = document.elementFromPoint(this.x, this.y);
    const info = describeElement(el, this.root);
    this.push({ t, x: this.x, y: this.y, scrollX: this.scroller.scrollLeft, scrollY: this.scroller.scrollTop, ...info });
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
