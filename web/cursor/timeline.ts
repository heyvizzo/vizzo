// Timeline (PRD FR11): cursor speed over time, word spans, shaded pointing-word windows, picked samples,
// and the turn's page events: click events (a tick per click, bracketed per event with its kind) and
// highlights (bars from start to finish; the pre-existing one as a marker).
import { isPointingWord, sampleSpeeds, wordWindow, type WindowOpts } from "../../shared/pointing.ts";
import type { ClickKind, CursorSample, PageEvents, PointingTarget, Word } from "../../shared/protocol.ts";
import { CLICK_COLOR, colorFor, HIGHLIGHT_COLOR, LABEL_COLOR, PRESELECTED_COLOR } from "./colors.ts";

export interface TimelineModel {
  /** ms relative to tAudioStart */
  t0: number;
  t1: number;
  /** px/s */
  speed: { t: number; v: number }[];
  vmax: number;
  words: { text: string; from: number; to: number; pointing: boolean; win: [number, number] | null }[];
  picks: { t: number; v: number; algorithm: string; word: string }[];
  /** Click events in time order, numbered from 1; `times` = every click's press time. */
  clicks: { n: number; kind: ClickKind; count: number; from: number; to: number; times: number[] }[];
  /** Highlights made during the recording, numbered from 1 (from = gesture start, to = finish). */
  highlights: { n: number; from: number; to: number }[];
  /** When the pre-existing highlight was snapshotted (the recording start), if any. */
  preselected: number | null;
}

/** "1×", "2×", … — the badge used for a click event everywhere in the lab. */
export const clickBadge = (count: number): string => `${count}×`;

/** Everything in ms relative to tAudioStart (pass tAudioStart = 0 for relative samples). */
export function buildTimelineModel(
  samples: readonly CursorSample[], words: readonly Word[], targets: readonly PointingTarget[], opts: WindowOpts, tAudioStart = 0,
  page: Partial<PageEvents> = {},
): TimelineModel {
  const clicks = [...(page.clicks ?? [])].sort((a, b) => a.t - b.t).map((c, i) => {
    const times = (c.times?.length ? c.times : [c.t]).map((t) => t - tAudioStart);
    return { n: i + 1, kind: c.kind, count: c.count, from: times[0]!, to: times[times.length - 1]!, times };
  });
  const highlights = (page.highlights ?? []).map((h, i) => ({ n: i + 1, from: h.tStart - tAudioStart, to: h.t - tAudioStart }));
  const preselected = page.preselected ? page.preselected.t - tAudioStart : null;
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
    ...clicks.flatMap((c) => c.times), ...highlights.flatMap((h) => [h.from, h.to]), ...(preselected === null ? [] : [preselected]),
  ];
  const t0 = Math.min(...times);
  const t1 = Math.max(...times, t0 + 1);
  // Robust y scale: 98th percentile so a single jump doesn't flatten the line.
  const vs = speed.map((p) => p.v).sort((a, b) => a - b);
  const vmax = Math.max(200, (vs[Math.floor(vs.length * 0.98)] ?? 0) * 1.1);
  return { t0, t1, speed, vmax, words: ws, picks, clicks, highlights, preselected };
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
  // Two event lanes on top (clicks, highlights), then the speed plot, then word spans, then the axis.
  const L = 44, R = 10, LANE_H = 15, CLICK_H = 22, CLICK_Y = 2, HL_Y = CLICK_Y + CLICK_H + 2, TOP = HL_Y + LANE_H + 4, WORDS_H = 34, AXIS_H = 16;
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
  g.fillText("clicks", 4, CLICK_Y + 15);
  g.fillText("highl.", 4, HL_Y + 11);
  g.fillStyle = "rgba(138,147,166,0.08)";
  g.fillRect(L, CLICK_Y, W - L - R, CLICK_H);
  g.fillRect(L, HL_Y, W - L - R, LANE_H);
  g.fillStyle = "#8a93a6";
  const step = niceStep(m.t1 - m.t0);
  for (let t = Math.ceil(m.t0 / step) * step; t <= m.t1; t += step) {
    g.fillText(`${(t / 1000).toFixed(step < 1000 ? 1 : 0)}s`, x(t) - 10, H - 3);
    g.fillRect(x(t), TOP + plotH, 1, 3);
  }
  // t = 0 (first audio sample)
  g.strokeStyle = "#8a93a6";
  g.setLineDash([3, 3]);
  g.beginPath();
  g.moveTo(x(0), CLICK_Y);
  g.lineTo(x(0), TOP + plotH);
  g.stroke();
  g.setLineDash([]);

  // Highlights: a bar from gesture start to finish ("H1", "H2"), lightly shaded down through the plot;
  // the pre-existing highlight as an amber flag at the recording start.
  for (const h of m.highlights) {
    const x0 = x(h.from), w = Math.max(3, x(h.to) - x0);
    g.fillStyle = "rgba(110,168,254,0.10)";
    g.fillRect(x0, TOP, w, plotH);
    g.fillStyle = HIGHLIGHT_COLOR;
    g.fillRect(x0, HL_Y + 2, w, LANE_H - 4);
    g.fillStyle = "#0b0d12";
    const label = `H${h.n}`;
    if (g.measureText(label).width + 4 <= w) g.fillText(label, x0 + 2, HL_Y + 11);
    else { g.fillStyle = HIGHLIGHT_COLOR; g.fillText(label, x0 + w + 2, HL_Y + 11); }
  }
  if (m.preselected !== null) {
    const px = x(m.preselected);
    g.fillStyle = PRESELECTED_COLOR;
    g.fillRect(px - 1, HL_Y, 2, LANE_H);
    g.beginPath();
    g.moveTo(px, HL_Y);
    g.lineTo(px + 8, HL_Y + 4);
    g.lineTo(px, HL_Y + 8);
    g.fill();
    g.fillText("pre", px + 10, HL_Y + 11);
  }

  // Speed line
  g.strokeStyle = "#e6e8ee";
  g.lineWidth = 1.2;
  g.beginPath();
  m.speed.forEach((p, i) => (i ? g.lineTo(x(p.t), y(p.v)) : g.moveTo(x(p.t), y(p.v))));
  g.stroke();
  g.lineWidth = 1;
  // Word spans
  const wy = TOP + plotH + 6;
  for (const w of m.words) {
    g.fillStyle = w.pointing ? "rgba(110,168,254,0.55)" : "rgba(138,147,166,0.35)";
    g.fillRect(x(w.from), wy, Math.max(2, x(w.to) - x(w.from)), 12);
    g.fillStyle = w.pointing ? "#e6e8ee" : "#8a93a6";
    g.fillText(w.text, x(w.from), wy + 24);
  }

  // Click events: a thin tick through the plot for every click, and in the click lane a bracket over the
  // event's clicks with its badge ("2×") — alternating shade so neighbouring events stay apart.
  m.clicks.forEach((c, i) => {
    const color = i % 2 ? "#67e8f9" : CLICK_COLOR;
    g.fillStyle = color;
    g.globalAlpha = 0.75;
    for (const t of c.times) g.fillRect(Math.round(x(t)), CLICK_Y + CLICK_H - 3, 1.5, TOP + plotH - (CLICK_Y + CLICK_H - 3));
    g.globalAlpha = 1;
    const x0 = x(c.from), x1 = x(c.to);
    g.strokeStyle = color;
    g.beginPath();
    g.moveTo(x0, CLICK_Y + CLICK_H - 1);
    g.lineTo(x0, CLICK_Y + CLICK_H - 5);
    g.lineTo(x1, CLICK_Y + CLICK_H - 5);
    g.lineTo(x1, CLICK_Y + CLICK_H - 1);
    g.stroke();
    for (const t of c.times) {
      g.beginPath();
      g.arc(x(t), CLICK_Y + CLICK_H - 5, 2, 0, Math.PI * 2);
      g.fill();
    }
    g.fillText(clickBadge(c.count), x0 - 2, CLICK_Y + 10);
  });

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
