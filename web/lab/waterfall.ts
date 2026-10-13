// Per-turn waterfall (PRD FR4): one row per stage, bars in ms relative to release (t = 0), coloured by vendor.
// buildWaterfall() is pure (unit tested); renderWaterfall() draws it as SVG with DOM APIs (textContent only).
import type { Approach } from "../../shared/config.ts";
import type { MarkName } from "../../shared/marks.ts";

export type Vendor = "openai" | "elevenlabs" | "anthropic" | "client";

/** Validated categorical slots 1–4 (dataviz reference palette, dark steps) against the panel surface #171a21. */
export const VENDORS: { id: Vendor; label: string; color: string }[] = [
  { id: "client", label: "Client / local", color: "#3987e5" },
  { id: "anthropic", label: "Anthropic", color: "#d95926" },
  { id: "openai", label: "OpenAI", color: "#199e70" },
  { id: "elevenlabs", label: "ElevenLabs", color: "#c98500" },
];
export const vendorColor = (v: Vendor): string => VENDORS.find((x) => x.id === v)!.color;

export interface WfSegment { from: number; to: number; faint?: boolean; open?: boolean }
export interface WfTick { t: number; label: string }
export interface WfRow { label: string; vendor: Vendor; segments: WfSegment[]; ticks: WfTick[]; value: number | null; note: string }
export interface WfRef { t: number; label: string; strong?: boolean }
export interface Waterfall { rows: WfRow[]; refs: WfRef[]; min: number; max: number; ticks: number[] }

type Marks = Partial<Record<MarkName, number>>;

function vendorsFor(approach: Approach) {
  const isPipeline = approach === "pipeline";
  return {
    stt: (approach === "realtime" ? "openai" : "elevenlabs") as Vendor,
    llm: (isPipeline ? "anthropic" : "openai") as Vendor,
    tts: (isPipeline ? "elevenlabs" : "openai") as Vendor,
  };
}

/** Nice axis ticks covering [min, max] (~targetCount ticks, step 1/2/5 × 10^k). */
export function niceTicks(min: number, max: number, targetCount = 8): { min: number; max: number; ticks: number[] } {
  const span = Math.max(1, max - min);
  const raw = span / targetCount;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * pow >= raw) ?? 10) * pow;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Math.round(t * 1000) / 1000);
  return { min: lo, max: hi, ticks };
}

/**
 * Rows from absolute marks. Times are relative to `release`; if release isn't stamped yet (live turn in progress),
 * `now` stands in for it. `now` (absolute) also draws open-ended stages that have started but not ended yet.
 */
export function buildWaterfall(marks: Marks, approach: Approach, now?: number): Waterfall {
  const r0 = marks.release ?? now ?? marks.press ?? 0;
  const rel = (n: MarkName): number | null => (marks[n] === undefined ? null : marks[n]! - r0);
  const nowRel = now === undefined ? null : now - r0;
  const v = vendorsFor(approach);
  const rows: WfRow[] = [];

  /** A bar from `from` to `to`; if only `from` exists and `now` is given, an open bar to now. */
  const bar = (label: string, vendor: Vendor, from: number | null, to: number | null, extra: Partial<WfRow> = {}) => {
    if (from === null && to === null) return;
    let segs: WfSegment[];
    if (from !== null && to !== null) segs = [{ from, to: Math.max(from, to) }];
    else if (from !== null && nowRel !== null && nowRel > from) segs = [{ from, to: nowRel, open: true }];
    else if (to !== null) segs = [{ from: to, to }];
    else return;
    rows.push({ label, vendor, segments: segs, ticks: [], value: to, note: "", ...extra });
  };
  const fmt = (x: number | null) => (x === null ? "–" : `${Math.round(x)} ms`);

  bar("Speech (hold)", "client", rel("press"), marks.release === undefined ? null : 0, { value: null, note: "press → release" });

  const sttFinal = rel("stt.final");
  const firstPartial = rel("stt.firstPartial");
  if (sttFinal !== null || firstPartial !== null) {
    const from = firstPartial !== null ? Math.min(firstPartial, 0) : 0;
    bar("STT final", v.stt, from, sttFinal, {
      ticks: firstPartial !== null ? [{ t: firstPartial, label: `first partial ${fmt(firstPartial)}` }] : [],
      note: "first partial → committed transcript (bar after 0 = release → final)",
    });
    // Before release STT streams alongside speech: draw that part faint.
    const row = rows[rows.length - 1];
    if (row && row.segments[0] && row.segments[0].from < 0) {
      const s = row.segments[0];
      row.segments = [{ from: s.from, to: Math.min(0, s.to), faint: true }, ...(s.to > 0 ? [{ ...s, from: 0 }] : [])];
    }
  }
  bar("Pointing", "client", sttFinal, rel("pointing.resolved"), { note: "stt.final → resolver done" });

  const llmReq = rel("llm.request");
  bar("Voice LLM", v.llm, llmReq, rel("llm.firstToken"), { note: "llm.request → first token" });
  if (rel("llm.toolCall") !== null) bar("ask_opus call", v.llm, llmReq, rel("llm.toolCall"), { note: "llm.request → tool call" });

  const ackBase = rel("llm.firstToken") ?? llmReq;
  bar("Ack TTS", v.tts, ackBase, rel("ack.ttsFirstByte"), { note: "first token → ack first audio byte" });
  bar("Ack playback", "client", rel("ack.ttsFirstByte"), rel("ack.played"), { note: "first byte → first sample played" });

  const opusReq = rel("opus.request");
  const opusFirst = rel("opus.firstToken");
  const opusSpoken = rel("opus.spokenReady");
  const opusDone = rel("opus.done");
  if (opusReq !== null) {
    const segs: WfSegment[] = [];
    const end = opusDone ?? (nowRel !== null && nowRel > opusReq ? nowRel : null);
    if (opusFirst !== null) {
      segs.push({ from: opusReq, to: opusFirst, faint: true });
      if (end !== null) segs.push({ from: opusFirst, to: Math.max(opusFirst, end), open: opusDone === null });
    } else if (end !== null) segs.push({ from: opusReq, to: end, faint: true, open: opusDone === null });
    else segs.push({ from: opusReq, to: opusReq });
    const ticks: WfTick[] = [];
    if (opusFirst !== null) ticks.push({ t: opusFirst, label: `first token ${fmt(opusFirst)}` });
    if (opusSpoken !== null) ticks.push({ t: opusSpoken, label: `SPOKEN line ready ${fmt(opusSpoken)}` });
    rows.push({ label: "Opus", vendor: "anthropic", segments: segs, ticks, value: opusDone, note: "request → first token (faint) → done" });
  }

  bar("Answer TTS", v.tts, opusSpoken ?? rel("llm.firstToken"), rel("answer.ttsFirstByte"), { note: "spoken line (or first token) → answer first byte" });
  bar("Answer playback", "client", rel("answer.ttsFirstByte"), rel("answer.played"), { note: "first byte → first sample played" });

  const refs: WfRef[] = [{ t: 0, label: "release", strong: true }];
  const played = [rel("ack.played"), rel("answer.played")].filter((x): x is number => x !== null);
  if (played.length) refs.push({ t: Math.min(...played), label: "TTFA" });
  const tta = rel("answer.played");
  if (tta !== null && tta !== Math.min(...played)) refs.push({ t: tta, label: "TTA" });
  const end = rel("turn.end");
  if (end !== null) refs.push({ t: end, label: "end" });

  const all = [0, ...rows.flatMap((r) => [...r.segments.flatMap((s) => [s.from, s.to]), ...r.ticks.map((t) => t.t)]), ...refs.map((x) => x.t)];
  const axis = niceTicks(Math.min(...all), Math.max(100, ...all));
  return { rows, refs, ...axis };
}

// ── rendering ───────────────────────────────────────

const NS = "http://www.w3.org/2000/svg";
function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, val] of Object.entries(attrs)) e.setAttribute(k, String(val));
  parent?.appendChild(e);
  return e;
}
function titled(e: SVGElement, text: string): void {
  el("title", {}, e).textContent = text;
}

const ROW_H = 24;
const BAR_H = 12;
const LABEL_W = 118;
const VALUE_W = 64;
const TOP = 34;
const BOTTOM = 24;

export function renderWaterfall(host: HTMLElement, wf: Waterfall): void {
  host.replaceChildren();
  if (!wf.rows.length) {
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = "No marks yet. Run a turn, or click a run in the list.";
    host.appendChild(p);
    return;
  }
  const W = Math.max(300, host.clientWidth || 640);
  const H = TOP + wf.rows.length * ROW_H + BOTTOM;
  const x0 = LABEL_W;
  const x1 = W - VALUE_W;
  const x = (t: number) => x0 + ((t - wf.min) / (wf.max - wf.min || 1)) * (x1 - x0);
  const svg = el("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "wf-svg", role: "img", "aria-label": "Turn waterfall, ms from release" });

  // grid + axis
  const step = wf.ticks.length > 1 ? wf.ticks[1]! - wf.ticks[0]! : 1;
  const labelEvery = (x1 - x0) / wf.ticks.length < 44 ? 2 : 1;
  wf.ticks.forEach((t, i) => {
    el("line", { x1: x(t), x2: x(t), y1: TOP - 4, y2: H - BOTTOM, class: "wf-grid" }, svg);
    if (i % labelEvery === 0) {
      const lbl = el("text", { x: x(t), y: H - BOTTOM + 15, class: "wf-axis", "text-anchor": "middle" }, svg);
      lbl.textContent = step >= 1000 || Math.abs(t) >= 10000 ? `${(t / 1000).toFixed(step >= 1000 ? 0 : 1)}s` : String(t);
    }
  });
  const unit = el("text", { x: x0 - 14, y: H - BOTTOM + 15, class: "wf-axis", "text-anchor": "end" }, svg);
  unit.textContent = step >= 1000 ? "time (s)" : "time (ms)";

  // reference lines (release, TTFA, TTA, end); labels move to a second lane when they would overlap
  const laneEnd = [-Infinity, -Infinity];
  for (const ref of [...wf.refs].sort((a, b) => a.t - b.t)) {
    const rx = x(ref.t);
    el("line", { x1: rx, x2: rx, y1: TOP - 4, y2: H - BOTTOM, class: ref.strong ? "wf-ref strong" : "wf-ref" }, svg);
    const text = ref.t === 0 && ref.strong ? ref.label : `${ref.label} ${Math.round(ref.t)}`;
    const half = (text.length * 6.2) / 2; // ~11px tabular font
    const lane = rx - half - 6 >= laneEnd[0]! ? 0 : rx - half - 6 >= laneEnd[1]! ? 1 : 0;
    laneEnd[lane] = rx + half;
    const lbl = el("text", { x: rx, y: lane ? TOP - 19 : TOP - 7, class: "wf-ref-label", "text-anchor": "middle" }, svg);
    lbl.textContent = text;
  }

  wf.rows.forEach((row, i) => {
    const yMid = TOP + i * ROW_H + ROW_H / 2;
    const g = el("g", { class: "wf-row" }, svg);
    const name = el("text", { x: 8, y: yMid + 4, class: "wf-label" }, g);
    name.textContent = row.label;
    const color = vendorColor(row.vendor);
    const vendorLabel = VENDORS.find((v) => v.id === row.vendor)!.label;
    for (const s of row.segments) {
      const w = Math.max(2, x(s.to) - x(s.from));
      const rect = el("rect", {
        x: x(s.from), y: yMid - BAR_H / 2, width: w, height: BAR_H, rx: 2, fill: color,
        "fill-opacity": s.faint ? 0.4 : 1, class: s.open ? "wf-bar open" : "wf-bar",
      }, g);
      titled(rect, `${row.label} (${vendorLabel}): ${Math.round(s.from)} → ${Math.round(s.to)} ms${s.open ? " (in progress)" : ""}\n${row.note}`);
    }
    for (const tk of row.ticks) {
      const c = el("circle", { cx: x(tk.t), cy: yMid, r: 4, fill: color, class: "wf-tick" }, g);
      titled(c, `${row.label}: ${tk.label}`);
    }
    if (row.value !== null) {
      const val = el("text", { x: x1 + 6, y: yMid + 4, class: "wf-value" }, g);
      val.textContent = `${Math.round(row.value)}`;
    }
    // full-row hit target for the tooltip
    const hit = el("rect", { x: 0, y: yMid - ROW_H / 2, width: W, height: ROW_H, class: "wf-hit" }, g);
    titled(hit, `${row.label} (${vendorLabel})${row.value !== null ? `: ${Math.round(row.value)} ms after release` : ""}\n${row.note}`);
    g.insertBefore(hit, g.firstChild);
  });
  host.appendChild(svg);
}

export function renderVendorLegend(host: HTMLElement): void {
  host.replaceChildren(...VENDORS.map((v) => {
    const s = document.createElement("span");
    const sw = document.createElement("i");
    sw.style.background = v.color;
    s.append(sw, document.createTextNode(v.label));
    return s;
  }));
}
