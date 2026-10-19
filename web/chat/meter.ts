// Level graph for Always listen: a few seconds of microphone level and a horizontal line
// the user drags to set the minimum that starts a turn. The line and the gate share one
// linear RMS value; the graph is drawn in dB so quiet speech is still movable.

import { THEME, withAlpha } from "../../shared/theme.ts";

/** Bottom and top of the drawn scale, dBFS. */
export const METER_FLOOR_DB = -60;
export const METER_CEIL_DB = 0;
/** The line stays inset from the edges so it can always be grabbed. */
export const THRESHOLD_MIN_DB = -54;
export const THRESHOLD_MAX_DB = -6;
export const DEFAULT_THRESHOLD_DB = -32;

const WINDOW_MS = 6_000;

export function rmsToDb(rms: number): number {
  return 20 * Math.log10(Math.max(rms, 1e-8));
}

export function dbToRms(db: number): number {
  return 10 ** (db / 20);
}

export function clampDb(db: number): number {
  return Math.min(THRESHOLD_MAX_DB, Math.max(THRESHOLD_MIN_DB, db));
}

/** Stored thresholds that aren't a finite positive RMS become the default line. */
export function clampThreshold(rms: number): number {
  if (typeof rms !== "number" || !Number.isFinite(rms) || rms <= 0) return dbToRms(DEFAULT_THRESHOLD_DB);
  return dbToRms(clampDb(rmsToDb(rms)));
}

export const DEFAULT_LISTEN_RMS = dbToRms(DEFAULT_THRESHOLD_DB);

/** 0 = bottom of the graph, 1 = top. */
export function dbToPos(db: number): number {
  if (!Number.isFinite(db)) return 0;
  const t = (db - METER_FLOOR_DB) / (METER_CEIL_DB - METER_FLOOR_DB);
  return Math.min(1, Math.max(0, t));
}

export function posToDb(pos: number): number {
  const p = Math.min(1, Math.max(0, pos));
  return METER_FLOOR_DB + p * (METER_CEIL_DB - METER_FLOOR_DB);
}

/** Pointer y (CSS pixels, 0 at the canvas top) inside the plot → threshold RMS. */
export function yToThreshold(y: number, plotTop: number, plotHeight: number): number {
  if (!(plotHeight > 0)) return DEFAULT_LISTEN_RMS;
  const pos = 1 - (y - plotTop) / plotHeight;
  return dbToRms(clampDb(posToDb(pos)));
}

export function formatDb(rms: number): string {
  const db = Math.round(rmsToDb(rms));
  return `${db < 0 ? "\u2212" : ""}${Math.abs(db)} dB`;
}

interface Sample { rms: number; t: number }

export interface LevelMeter {
  push(rms: number, t?: number): void;
  setLive(live: boolean): void;
  redraw(): void;
}

const PAD_L = 8;
const PAD_R = 68;
const PAD_Y = 10;

/**
 * Draw and drag the meter on `canvas`. `onThreshold` fires for a drag or the arrow keys,
 * with the clamped linear RMS.
 */
export function mountLevelMeter(canvas: HTMLCanvasElement, opts: {
  threshold: number;
  onThreshold: (rms: number) => void;
}): LevelMeter {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("meter canvas has no 2d context");
  let threshold = clampThreshold(opts.threshold);
  let live = false;
  let dragging = false;
  const samples: Sample[] = [];
  let cssW = 0;
  let cssH = 0;

  const colors = () => {
    const css = getComputedStyle(document.documentElement);
    const pick = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    return {
      accent: pick("--accent", THEME.dark.accent),
      warn: pick("--warn", THEME.dark.warn),
      err: pick("--err", THEME.dark.err),
      muted: pick("--muted", THEME.dark.muted),
      line: pick("--line", THEME.dark.line),
      panel: pick("--panel", THEME.dark.panel),
    };
  };

  const syncAria = () => {
    const db = Math.round(rmsToDb(threshold));
    canvas.setAttribute("aria-valuemin", String(THRESHOLD_MIN_DB));
    canvas.setAttribute("aria-valuemax", String(THRESHOLD_MAX_DB));
    canvas.setAttribute("aria-valuenow", String(db));
    canvas.setAttribute("aria-valuetext", formatDb(threshold));
  };

  const plot = () => {
    const plotW = Math.max(1, cssW - PAD_L - PAD_R);
    const plotH = Math.max(1, cssH - PAD_Y * 2);
    return { plotL: PAD_L, plotTop: PAD_Y, plotW, plotH };
  };

  const yOf = (rms: number, plotTop: number, plotH: number) => plotTop + (1 - dbToPos(rmsToDb(rms))) * plotH;

  const draw = () => {
    if (cssW < 2 || cssH < 2) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const c = colors();
    const { plotL, plotTop, plotW, plotH } = plot();
    const lineY = yOf(threshold, plotTop, plotH);
    const mark = live ? c.err : c.warn;

    ctx.fillStyle = withAlpha(c.err, 0.1);
    ctx.fillRect(plotL, plotTop, plotW, Math.max(0, lineY - plotTop));

    ctx.strokeStyle = c.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const db of [-48, -36, -24, -12]) {
      const y = plotTop + (1 - dbToPos(db)) * plotH;
      ctx.moveTo(plotL, y);
      ctx.lineTo(plotL + plotW, y);
    }
    ctx.stroke();

    const now = samples.length ? samples[samples.length - 1]!.t : performance.now();
    const t0 = now - WINDOW_MS;
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotL, plotTop, plotW, plotH);
    ctx.clip();
    ctx.beginPath();
    let started = false;
    let firstX = plotL;
    let lastX = plotL;
    let lastY = lineY;
    for (const s of samples) {
      const x = plotL + ((s.t - t0) / WINDOW_MS) * plotW;
      if (x < plotL) continue;
      const y = yOf(s.rms, plotTop, plotH);
      if (!started) { ctx.moveTo(x, y); started = true; firstX = x; }
      else ctx.lineTo(x, y);
      lastX = x;
      lastY = y;
    }
    if (started) {
      const over = samples[samples.length - 1]!.rms >= threshold;
      ctx.lineTo(lastX, plotTop + plotH);
      ctx.lineTo(firstX, plotTop + plotH);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, plotTop, 0, plotTop + plotH);
      g.addColorStop(0, over ? withAlpha(c.err, 0.45) : withAlpha(c.accent, 0.4));
      g.addColorStop(1, withAlpha(c.accent, 0));
      ctx.fillStyle = g;
      ctx.fill();
      ctx.beginPath();
      started = false;
      for (const s of samples) {
        const x = plotL + ((s.t - t0) / WINDOW_MS) * plotW;
        if (x < plotL) continue;
        const y = yOf(s.rms, plotTop, plotH);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = over ? c.err : c.accent;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.fillStyle = over ? c.err : c.accent;
      ctx.beginPath();
      ctx.arc(lastX, lastY, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    ctx.strokeStyle = mark;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(plotL, lineY);
    ctx.lineTo(plotL + plotW, lineY);
    ctx.stroke();

    const label = formatDb(threshold);
    ctx.font = "11px ui-monospace, monospace";
    const tw = ctx.measureText(label).width;
    const hw = tw + 12;
    const hh = 18;
    const hx = plotL + plotW + 6;
    const hy = Math.min(cssH - hh - 2, Math.max(2, lineY - hh / 2));
    ctx.fillStyle = c.panel;
    ctx.strokeStyle = mark;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(hx, hy, hw, hh, 9);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = mark;
    ctx.textBaseline = "middle";
    ctx.fillText(label, hx + 6, hy + hh / 2 + 0.5);
  };

  const layout = () => {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssW = rect.width;
    cssH = rect.height;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    draw();
  };

  const setFromPointer = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const { plotTop, plotH } = plot();
    threshold = yToThreshold(e.clientY - rect.top, plotTop, cssH > 0 ? plotH : rect.height - PAD_Y * 2);
    syncAria();
    opts.onThreshold(threshold);
    draw();
  };

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    canvas.focus({ preventScroll: true });
    dragging = true;
    setFromPointer(e);
  });
  canvas.addEventListener("pointermove", (e) => { if (dragging) setFromPointer(e); });
  const endDrag = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    setFromPointer(e);
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  canvas.addEventListener("keydown", (e) => {
    let dir = 0;
    let step = 1;
    if (e.key === "ArrowUp") dir = 1;
    else if (e.key === "ArrowDown") dir = -1;
    else if (e.key === "PageUp") { dir = 1; step = 6; }
    else if (e.key === "PageDown") { dir = -1; step = 6; }
    else return;
    e.preventDefault();
    threshold = dbToRms(clampDb(rmsToDb(threshold) + dir * step));
    syncAria();
    opts.onThreshold(threshold);
    draw();
  });

  const ro = new ResizeObserver(() => layout());
  ro.observe(canvas);
  syncAria();
  layout();

  return {
    push(rms, t = performance.now()) {
      samples.push({ rms, t });
      const cutoff = t - WINDOW_MS;
      while (samples.length > 2 && samples[0]!.t < cutoff) samples.shift();
      draw();
    },
    setLive(next) {
      if (live === next) return;
      live = next;
      canvas.classList.toggle("live", live);
      draw();
    },
    redraw() { layout(); },
  };
}
