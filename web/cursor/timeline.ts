// Timeline (PRD FR11): cursor speed over time, word spans, shaded pointing-word windows, picked samples.
import { isPointingWord, sampleSpeeds, wordWindow, type WindowOpts } from "../../shared/pointing.ts";
import type { CursorSample, PageClick, PageSelection, PointingTarget, Word } from "../../shared/protocol.ts";
import { CLICK_COLOR, colorFor, LABEL_COLOR, SELECTION_COLOR } from "./colors.ts";

export interface TimelineModel {
  /** ms relative to tAudioStart */
  t0: number;
  t1: number;
  /** px/s */
  speed: { t: number; v: number }[];
  vmax: number;
  words: { text: string; from: number; to: number; pointing: boolean; win: [number, number] | null }[];
  picks: { t: number; v: number; algorithm: string; word: string }[];
  /** Clicks during the turn, numbered from 1 in time order. */
  clicks: { t: number; n: number }[];
  /** When the highlighted text was selected, if any. */
  selection: number | null;
}

/** Everything in ms relative to tAudioStart (pass tAudioStart = 0 for relative samples). */
export function buildTimelineModel(
  samples: readonly CursorSample[], words: readonly Word[], targets: readonly PointingTarget[], opts: WindowOpts, tAudioStart = 0,
  page: { clicks?: readonly PageClick[]; selection?: PageSelection | null } = {},
): TimelineModel {
  const clicks = [...(page.clicks ?? [])].sort((a, b) => a.t - b.t).map((c, i) => ({ t: c.t - tAudioStart, n: i + 1 }));
  const selection = page.selection ? page.selection.t - tAudioStart : null;
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const sp = sampleSpeeds(sorted);
  const speed = sorted.flatMap((s, i) => (Number.isNaN(sp[i]) ? [] : [{ t: s.t - tAudioStart, v: sp[i]! * 1000 }]));
  const ws = words.map((w) => {
    const pointing = isPointingWord(w.text);
    const win = wordWindow(w, 0, opts);
    return { text: w.text, from: w.start * 1000, to: w.end * 1000, pointing, win: pointing ? ([win.from, win.to] as [number, number]) : null };
  });
  const speedAt = (t: number) => {
    let best = speed[0];
    for (const p of speed) if (Math.abs(p.t - t) < Math.abs(best!.t - t)) best = p;
    return best?.v ?? 0;
  };
  const picks = targets.flatMap((p) => (p.sample ? [{ t: p.sample.t - tAudioStart, v: speedAt(p.sample.t - tAudioStart), algorithm: p.algorithm, word: p.word }] : []));
  const times = [
    ...speed.map((p) => p.t), ...ws.flatMap((w) => [w.win?.[0] ?? w.from, w.win?.[1] ?? w.to]), 0,
    ...clicks.map((c) => c.t), ...(selection === null ? [] : [selection]),
  ];
  const t0 = Math.min(...times);
  const t1 = Math.max(...times, t0 + 1);
  // Robust y scale: 98th percentile so a single jump doesn't flatten the line.
  const vs = speed.map((p) => p.v).sort((a, b) => a - b);
  const vmax = Math.max(200, (vs[Math.floor(vs.length * 0.98)] ?? 0) * 1.1);
  return { t0, t1, speed, vmax, words: ws, picks, clicks, selection };
}

/** Draws the model (null = placeholder text). Only algorithms in `visible` get pick markers. */
export function drawTimeline(canvas: HTMLCanvasElement, m: TimelineModel | null, visible: Set<string>): void {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const g = canvas.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.font = "11px ui-monospace, monospace";
  if (!m) {
    g.fillStyle = "#8a93a6";
    g.fillText("Hold to talk while pointing at the demo page; the timeline appears after the transcript.", 12, H / 2);
    return;
  }
  const L = 44, R = 10, TOP = 8, WORDS_H = 34, AXIS_H = 16;
  const plotH = H - TOP - WORDS_H - AXIS_H;
  const x = (t: number) => L + ((t - m.t0) / (m.t1 - m.t0)) * (W - L - R);
  const y = (v: number) => TOP + plotH - (Math.min(v, m.vmax) / m.vmax) * plotH;

  // Pointing windows
  for (const w of m.words) {
    if (!w.win) continue;
    g.fillStyle = "rgba(110,168,254,0.12)";
    g.fillRect(x(w.win[0]), TOP, x(w.win[1]) - x(w.win[0]), plotH + WORDS_H);
  }
  // Axes
  g.strokeStyle = "#2a2f3a";
  g.beginPath();
  g.moveTo(L, TOP);
  g.lineTo(L, TOP + plotH);
  g.lineTo(W - R, TOP + plotH);
  g.stroke();
  g.fillStyle = "#8a93a6";
  g.fillText(`${Math.round(m.vmax)}`, 4, TOP + 10);
  g.fillText("px/s", 4, TOP + 22);
  g.fillText("0", L - 12, TOP + plotH);
  const step = niceStep(m.t1 - m.t0);
  for (let t = Math.ceil(m.t0 / step) * step; t <= m.t1; t += step) {
    g.fillText(`${(t / 1000).toFixed(step < 1000 ? 1 : 0)}s`, x(t) - 10, H - 3);
    g.fillRect(x(t), TOP + plotH, 1, 3);
  }
  // t = 0 (first audio sample)
  g.strokeStyle = "#8a93a6";
  g.setLineDash([3, 3]);
  g.beginPath();
  g.moveTo(x(0), TOP);
  g.lineTo(x(0), TOP + plotH);
  g.stroke();
  g.setLineDash([]);
  // Speed line
  g.strokeStyle = "#e6e8ee";
  g.lineWidth = 1.2;
  g.beginPath();
  m.speed.forEach((p, i) => (i ? g.lineTo(x(p.t), y(p.v)) : g.moveTo(x(p.t), y(p.v))));
  g.stroke();
  // Word spans
  const wy = TOP + plotH + 6;
  for (const w of m.words) {
    g.fillStyle = w.pointing ? "rgba(110,168,254,0.55)" : "rgba(138,147,166,0.35)";
    g.fillRect(x(w.from), wy, Math.max(2, x(w.to) - x(w.from)), 12);
    g.fillStyle = w.pointing ? "#e6e8ee" : "#8a93a6";
    g.fillText(w.text, x(w.from), wy + 24);
  }
  // Clicks (numbered ticks) and the selection time
  const tick = (t: number, color: string, text: string) => {
    g.fillStyle = color;
    g.fillRect(Math.round(x(t)), TOP, 1.5, plotH);
    g.beginPath();
    g.moveTo(x(t) - 4, TOP);
    g.lineTo(x(t) + 4, TOP);
    g.lineTo(x(t), TOP + 6);
    g.fill();
    g.fillText(text, x(t) + 4, TOP + 16);
  };
  if (m.selection !== null) tick(m.selection, SELECTION_COLOR, "sel");
  for (const c of m.clicks) tick(c.t, CLICK_COLOR, `click ${c.n}`);
  // Picks
  const seen = new Map<string, number>();
  for (const p of m.picks) {
    if (!visible.has(p.algorithm)) continue;
    const key = `${Math.round(x(p.t))}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    g.fillStyle = colorFor(p.algorithm);
    g.strokeStyle = LABEL_COLOR;
    g.beginPath();
    g.arc(x(p.t), y(p.v) - n * 7, 4.5, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }
}

function niceStep(span: number): number {
  for (const s of [100, 200, 250, 500, 1000, 2000, 5000, 10000]) if (span / s <= 12) return s;
  return 20000;
}
