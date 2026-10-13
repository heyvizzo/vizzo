// Cursor lab (TASKS T9, PRD FR7–FR13).
import "./cursor.css";
import { connectWithStatus } from "../common.ts";
import { DEFAULT_CONFIG, type RunConfig } from "../../shared/config.ts";
import {
  ALGORITHMS, formatPageContext, formatPointingContext, relTime, resolvePointing, sortClicks, tagFromPath, truncateText, wordNear,
  type WindowOpts,
} from "../../shared/pointing.ts";
import type { CursorSample, PageEvents, PointingTarget, ServerMsg, Word } from "../../shared/protocol.ts";
import { startCapture, type CaptureHandle } from "../audio/capture.ts";
import { bindPushToTalk } from "../audio/ptt.ts";
import { createWavRecorder, type WavRecorder } from "../audio/record.ts";
import { startReplay, type ReplayHandle } from "../audio/replay.ts";
import { colorFor } from "./colors.ts";
import { mountDemo } from "./demoLoader.ts";
import { describeElement } from "./dom.ts";
import { cannedSession, hoverElement } from "./devDemo.ts";
import { findPath, renderHover, renderOverlay } from "./overlay.ts";
import { createPageContextRecorder } from "./pageContext.ts";
import { Sampler } from "./sampler.ts";
import { pct, scoreSessions, targetMatches } from "./scoring.ts";
import {
  labelsFor, nextSessionId, sessionEvents, sessionsFromFiles, shiftEvents, toCursorFile, toLabelsFile, toRelativeSamples,
  type LabSession, type LoadedFile,
} from "./session.ts";
import { buildTimelineModel, clickBadge, drawTimeline } from "./timeline.ts";

const PRE_ROLL_MS = 500; // cursor history sent/saved from before the press
const POST_ROLL_MS = 300; // and kept after the release
const BATCH_MS = 100;

const app = document.getElementById("app")!;
app.classList.add("cursor-lab");
app.innerHTML = `
<div class="cl-demo" id="demo-scroller">
  <div id="demo-root"></div>
  <div id="hover-layer" aria-hidden="true"></div>
  <div id="ov-layer" aria-hidden="true"></div>
</div>
<aside class="cl-side">
  <section class="panel">
    <div class="row">
      <button id="ptt" class="ptt">Hold to talk <span class="muted">(or Space)</span></button>
      <span id="turn-status" class="muted"></span>
    </div>
    <p id="transcript" class="transcript muted">Point at something on the page and say e.g. “move this over there”. Clicks and highlighted text count too.</p>
    <p id="latency" class="muted mono small"></p>
  </section>
  <section class="panel">
    <h3>Under the cursor</h3>
    <div id="inspector" class="inspector"></div>
  </section>
  <section class="panel">
    <h3>Algorithms</h3>
    <div id="legend" class="legend"></div>
    <label class="slider">preMs <input id="pre" type="range" min="0" max="1500" step="25" /> <span id="pre-v" class="mono"></span></label>
    <label class="slider">postMs <input id="post" type="range" min="0" max="1500" step="25" /> <span id="post-v" class="mono"></span></label>
  </section>
  <section class="panel">
    <h3>Picks <span id="active-id" class="muted"></span></h3>
    <div id="picks"></div>
    <h4>Clicks &amp; highlights <span id="page-ctx-note" class="muted"></span></h4>
    <div id="page-ctx" class="page-ctx"></div>
    <h4>LLM context <span class="muted">(dwellMode, as the server formats it)</span></h4>
    <pre id="server-ctx" class="mono small ctx-block"></pre>
  </section>
  <section class="panel">
    <h3>Sessions</h3>
    <div class="row">
      <input id="sess-id" size="5" class="mono" title="Session id (file name prefix)" />
      <button id="save">Save files</button>
      <label class="file-btn">Load…<input id="load" type="file" multiple accept=".json,.wav" hidden /></label>
    </div>
    <p class="muted small">Saves <span class="mono">Uxx.wav</span>, <span class="mono">Uxx.cursor.json</span>, <span class="mono">Uxx.labels.json</span> (fixtures/utterances layout).</p>
    <div id="sessions"></div>
    <p id="load-errors" class="err small"></p>
  </section>
  <section class="panel">
    <h3>Accuracy</h3>
    <div id="accuracy"></div>
  </section>
</aside>
<section class="cl-timeline panel"><canvas id="timeline"></canvas></section>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const scroller = $("demo-scroller");
const demoRoot = $("demo-root");
const layer = $("ov-layer");
const hoverLayer = $("hover-layer");
const canvas = $<HTMLCanvasElement>("timeline");

// ── state ──────────────────────────────────────────
const state = {
  opts: { preMs: DEFAULT_CONFIG.preMs, postMs: DEFAULT_CONFIG.postMs } as WindowOpts,
  visible: new Set(ALGORITHMS),
  sessions: [] as LabSession[],
  active: null as LabSession | null,
  labeling: null as number | null, // wordIndex being labeled
};

interface Turn {
  turnId: string;
  tPress: number;
  tAudioStart?: number;
  tRelease?: number;
  audioStarted: Promise<void>;
  recorder: WavRecorder | null;
  capture?: CaptureHandle;
  replay?: ReplayHandle;
  replayOf?: LabSession;
  /** Replay only: the re-timed cursor trail (live turns read the sampler). */
  injected?: CursorSample[];
  sentUpTo: number; // cursor samples with t ≤ this were sent
  batchTimer?: ReturnType<typeof setInterval>;
  partial: string;
  /** What was clicked / highlighted during the turn (absolute client time), set at release. */
  events?: PageEvents;
}
let turn: Turn | null = null;
/** The recording turn's page events so far (absolute client time), for the live panel; null when not recording. */
let live: { events: PageEvents; t: Turn } | null = null;
/** The session made from the latest live turn: the recorder still paints its highlights on the page. */
let paintedSession: LabSession | null = null;

const sock = connectWithStatus();
const sampler = new Sampler(demoRoot, scroller);
const pageRecorder = createPageContextRecorder(demoRoot);
pageRecorder.onChange = (events) => {
  if (!turn || turn.tRelease !== undefined || turn.replay) return;
  live = { events, t: turn };
  renderPageContext(state.active);
  renderOverlayNow();
};

// ── demo page ──────────────────────────────────────
void mountDemo(demoRoot).then(async (info) => {
  if (info.source === "fallback") $("turn-status").textContent = "using built-in fallback demo";
  sampler.onSample = renderInspector;
  sampler.start();
  // Overlay boxes are positioned from live layout; redraw when the demo's layout changes.
  new ResizeObserver(() => renderOverlayNow()).observe(demoRoot);
  const demo = new URLSearchParams(location.search).get("demo");
  if (demo !== null) {
    // Let the demo's layout settle before taking element positions for the canned trail.
    await document.fonts.ready;
    await new Promise((r) => setTimeout(r, 300));
    const s = cannedSession(demoRoot, scroller);
    if (s) {
      upsertSession(s);
      state.active = s;
      // ?demo=title hovers a card title; anything else a table heading.
      hoverElement(demoRoot.querySelector(demo === "title" ? ".card:nth-of-type(3) h3" : ".pricing-table th:nth-of-type(3)"));
    }
    (window as unknown as { cursorLab?: unknown }).cursorLab = { dryStart, dryStop };
  }
  renderAll();
});

/**
 * Dev only (`?demo`, `window.cursorLab`): run the page recorder like a turn, without mic or server, so the
 * live panel, painted highlights and the resulting session can be exercised (e.g. from puppeteer).
 * Times are relative to the press (no audio start). dryStop() returns the turn's PageEvents (absolute).
 */
function dryStart(): void {
  if (turn) return;
  const tPress = performance.now();
  const t: Turn = { turnId: "dry", tPress, audioStarted: Promise.resolve(), recorder: null, sentUpTo: tPress, partial: "" };
  turn = t;
  paintedSession = null;
  live = { events: { clicks: [], preselected: null, highlights: [] }, t };
  pageRecorder.start(tPress);
  setStatus("dry turn (no mic): recording page events…");
}
function dryStop(): PageEvents | null {
  const t = turn;
  if (!t || t.turnId !== "dry") return null;
  t.tRelease = performance.now();
  const events = pageRecorder.stop();
  live = null;
  turn = null;
  const sess: LabSession = {
    id: nextSessionId(state.sessions.map((s) => s.id)), createdAt: new Date().toISOString(), transcript: "(dry turn: no audio)",
    words: [], labels: [], samples: toRelativeSamples(sampler.range(t.tPress - PRE_ROLL_MS, t.tRelease), t.tPress),
    viewport: { width: scroller.clientWidth, height: scroller.clientHeight }, ...shiftEvents(events, -t.tPress),
  };
  upsertSession(sess);
  state.active = paintedSession = sess;
  setStatus("dry turn done");
  renderAll();
  return events;
}

// ── turn flow ──────────────────────────────────────
function config(): RunConfig {
  return { ...DEFAULT_CONFIG, approach: "cursor-only", preMs: state.opts.preMs, postMs: state.opts.postMs };
}

function newTurn(extra: Partial<Turn> = {}): Turn {
  const tPress = performance.now();
  const t: Turn = {
    turnId: crypto.randomUUID(), tPress, audioStarted: Promise.resolve(), recorder: null,
    sentUpTo: tPress - PRE_ROLL_MS - 1, partial: "", ...extra,
  };
  try {
    t.recorder = createWavRecorder();
  } catch (e) {
    console.warn("[cursor] WAV recorder unavailable", e);
  }
  sock.send({ type: "turn.start", turnId: t.turnId, config: config(), tPress, ...(t.replayOf ? { fixtureId: t.replayOf.id } : {}) });
  t.batchTimer = setInterval(() => flushSamples(t), BATCH_MS);
  return t;
}

/** The turn's cursor trail so far (absolute client time). */
function turnSamples(t: Turn, to = Infinity): CursorSample[] {
  return t.injected ? t.injected.filter((s) => s.t <= to) : sampler.range(t.tPress - PRE_ROLL_MS, to);
}

function flushSamples(t: Turn): void {
  const fresh = turnSamples(t).filter((s) => s.t > t.sentUpTo);
  if (!fresh.length) return;
  t.sentUpTo = fresh[fresh.length - 1]!.t;
  sock.send({ type: "cursor.samples", turnId: t.turnId, samples: fresh });
}

function onFrame(t: Turn, pcm: Int16Array<ArrayBuffer>): void {
  if (turn !== t || t.tRelease !== undefined) return;
  sock.sendAudio(pcm);
  t.recorder?.push(pcm);
}

function setStatus(s: string): void {
  $("turn-status").textContent = s;
}

async function press(): Promise<void> {
  if (turn && turn.tRelease === undefined) return;
  if (!sock.isOpen) return setStatus("server not connected");
  const t = newTurn();
  turn = t;
  paintedSession = null; // start() clears the previous turn's painted highlights
  live = { events: { clicks: [], preselected: null, highlights: [] }, t };
  pageRecorder.start(t.tPress);
  setStatus("listening…");
  $("ptt").classList.add("live");
  $("transcript").textContent = "…";
  t.audioStarted = (async () => {
    try {
      t.capture = await startCapture({ onFrame: (pcm) => onFrame(t, pcm) });
      t.tAudioStart = await t.capture.tAudioStart;
      sock.send({ type: "turn.audioStart", turnId: t.turnId, tAudioStart: t.tAudioStart });
    } catch (e) {
      failTurn(t, `mic: ${(e as Error).message}`);
    }
  })();
}

async function release(): Promise<void> {
  const t = turn;
  if (!t || t.tRelease !== undefined || t.replay) return;
  t.tRelease = performance.now();
  t.events = pageRecorder.stop();
  live = null;
  $("ptt").classList.remove("live");
  await t.audioStarted;
  t.capture?.stop();
  if (turn !== t) return;
  flushSamples(t);
  clearInterval(t.batchTimer);
  sock.send({ type: "turn.context", turnId: t.turnId, ...t.events });
  sock.send({ type: "turn.release", turnId: t.turnId, tRelease: t.tRelease });
  setStatus("transcribing…");
  renderAll();
}

function failTurn(t: Turn, msg: string): void {
  clearInterval(t.batchTimer);
  t.capture?.stop();
  t.replay?.stop();
  if (!t.replay) pageRecorder.stop();
  if (live?.t === t) live = null;
  sampler.paused = false;
  sock.send({ type: "turn.cancel", turnId: t.turnId });
  if (turn === t) turn = null;
  $("ptt").classList.remove("live");
  setStatus(msg);
}

/** Replay a loaded session's WAV + cursor trail through the same path as a live turn (Scribe → resolvers). */
async function replaySession(s: LabSession): Promise<void> {
  if (turn && turn.tRelease === undefined) return;
  if (!s.wav) return setStatus(`${s.id}: no WAV loaded`);
  if (!sock.isOpen) return setStatus("server not connected");
  const wav = await s.wav.arrayBuffer();
  sampler.paused = true;
  const injected: CursorSample[] = [];
  const t = newTurn({ replayOf: s, sentUpTo: -Infinity, injected });
  turn = t;
  setStatus(`replaying ${s.id}…`);
  try {
    t.replay = startReplay({ wav, cursor: s.samples, onFrame: (pcm) => onFrame(t, pcm), onCursor: (c) => void injected.push(c) });
  } catch (e) {
    return failTurn(t, `replay: ${(e as Error).message}`);
  }
  t.audioStarted = t.replay.tAudioStart.then((ta) => {
    t.tAudioStart = ta;
    sock.send({ type: "turn.audioStart", turnId: t.turnId, tAudioStart: ta });
    // The saved page events, re-timed like the cursor trail (relative → this replay's clock).
    t.events = shiftEvents(sessionEvents(s), ta);
  });
  try {
    await t.audioStarted;
    await t.replay.done;
  } catch (e) {
    return failTurn(t, `replay: ${(e as Error).message}`);
  }
  if (turn !== t) return;
  t.tRelease = performance.now();
  flushSamples(t);
  clearInterval(t.batchTimer);
  sampler.paused = false;
  sock.send({ type: "turn.context", turnId: t.turnId, ...(t.events ?? sessionEvents({})) });
  sock.send({ type: "turn.release", turnId: t.turnId, tRelease: t.tRelease });
  setStatus("transcribing…");
}

sock.on((msg: ServerMsg) => {
  const t = turn;
  if (!t || !("turnId" in msg) || msg.turnId !== t.turnId) {
    if (msg.type === "error" && !msg.turnId) setStatus(`error (${msg.source}): ${msg.message}`);
    return;
  }
  switch (msg.type) {
    case "stt.partial":
      t.partial = msg.text;
      $("transcript").textContent = msg.text;
      return;
    case "mark":
      if (msg.name === "stt.final" && t.tRelease !== undefined)
        $("latency").textContent = `release → stt.final ${(sock.toClientTime(msg.serverNow) - t.tRelease).toFixed(0)} ms`;
      return;
    case "stt.final": {
      $("transcript").textContent = msg.text || "(empty transcript)";
      if (t.tAudioStart === undefined) return;
      const tEnd = (t.tRelease ?? performance.now()) + POST_ROLL_MS;
      const id = t.replayOf ? `${t.replayOf.id}r` : nextSessionId(state.sessions.map((s) => s.id));
      const sess: LabSession = {
        id, createdAt: new Date().toISOString(), transcript: msg.text, words: msg.words,
        samples: toRelativeSamples(turnSamples(t, tEnd), t.tAudioStart),
        labels: labelsFor(msg.words, t.replayOf?.labels ?? []),
        viewport: { width: scroller.clientWidth, height: scroller.clientHeight },
        ...shiftEvents(t.events ?? sessionEvents({}), -t.tAudioStart),
      };
      try {
        if (t.recorder && !t.replayOf) sess.wav = t.recorder.toWav();
      } catch (e) {
        console.warn("[cursor] toWav failed", e);
      }
      if (t.replayOf) sess.wav = t.replayOf.wav;
      // Late samples (up to POST_ROLL_MS after release) arrive after stt.final sometimes; top up shortly.
      setTimeout(() => {
        sess.samples = toRelativeSamples(turnSamples(t, tEnd), t.tAudioStart!);
        renderAll();
      }, Math.max(0, tEnd - performance.now()));
      upsertSession(sess);
      state.active = sess;
      if (!t.replayOf) paintedSession = sess;
      $<HTMLInputElement>("sess-id").value = sess.id;
      renderAll();
      return;
    }
    case "pointing.resolved":
      if (state.active) state.active.serverTargets = msg.targets;
      renderAll();
      return;
    case "turn.done":
      clearInterval(t.batchTimer);
      if (turn === t) turn = null;
      setStatus(msg.run.error ? `done (${msg.run.error})` : "done");
      return;
    case "error":
      setStatus(`error (${msg.source}): ${msg.message}`);
      return;
  }
});

function upsertSession(s: LabSession): void {
  const i = state.sessions.findIndex((x) => x.id === s.id);
  if (i >= 0) state.sessions[i] = s;
  else state.sessions.push(s);
  state.sessions.sort((a, b) => a.id.localeCompare(b.id));
}

try {
  bindPushToTalk({ button: $("ptt"), onPress: () => void press(), onRelease: () => void release() });
} catch (e) {
  setStatus(`push-to-talk unavailable: ${(e as Error).message}`);
}

// ── controls ───────────────────────────────────────
const pre = $<HTMLInputElement>("pre");
const post = $<HTMLInputElement>("post");
pre.value = String(state.opts.preMs);
post.value = String(state.opts.postMs);
const onSlider = () => {
  state.opts = { preMs: Number(pre.value), postMs: Number(post.value) };
  renderAll();
};
pre.addEventListener("input", onSlider);
post.addEventListener("input", onSlider);

$("legend").addEventListener("change", (e) => {
  const cb = e.target as HTMLInputElement;
  if (cb.checked) state.visible.add(cb.value);
  else state.visible.delete(cb.value);
  renderAll();
});

$("picks").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-label-word]");
  if (!b) return;
  const i = Number(b.dataset.labelWord);
  state.labeling = state.labeling === i ? null : i;
  renderAll();
});

// Labeling: the next click inside the demo page labels the armed word.
demoRoot.addEventListener("click", (e) => {
  if (state.labeling === null || !state.active) return;
  e.preventDefault();
  e.stopPropagation();
  const l = state.active.labels.find((x) => x.wordIndex === state.labeling);
  const info = describeElement(e.target as Element, demoRoot);
  if (l && info.elementPath) l.target = info;
  // Arm the next unlabeled word, if any.
  state.labeling = state.active.labels.find((x) => !x.target)?.wordIndex ?? null;
  renderAll();
}, true);
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.labeling !== null) {
    state.labeling = null;
    renderAll();
  }
});

$("save").addEventListener("click", () => {
  const s = state.active;
  if (!s) return setStatus("nothing to save yet");
  const id = $<HTMLInputElement>("sess-id").value.trim() || s.id;
  if (id !== s.id) {
    state.sessions = state.sessions.filter((x) => x.id !== id || x === s);
    s.id = id;
    state.sessions.sort((a, b) => a.id.localeCompare(b.id));
  }
  const json = (v: unknown) => new Blob([JSON.stringify(v, null, 1)], { type: "application/json" });
  if (s.wav) download(`${id}.wav`, s.wav);
  download(`${id}.cursor.json`, json(toCursorFile(s)));
  download(`${id}.labels.json`, json(toLabelsFile(s)));
  renderAll();
});

$<HTMLInputElement>("load").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const files: LoadedFile[] = await Promise.all(
    [...(input.files ?? [])].map(async (f) =>
      f.name.toLowerCase().endsWith(".wav") ? { name: f.name, blob: f } : { name: f.name, text: await f.text() }),
  );
  input.value = "";
  const { sessions, errors } = sessionsFromFiles(files);
  sessions.forEach(upsertSession);
  if (sessions.length) state.active = sessions[0]!;
  $("load-errors").textContent = errors.join("\n");
  renderAll();
});

$("sessions").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
  if (!b) return;
  const s = state.sessions.find((x) => x.id === b.dataset.id);
  if (!s) return;
  if (b.dataset.act === "view") {
    state.active = s;
    state.labeling = null;
    $<HTMLInputElement>("sess-id").value = s.id;
  } else if (b.dataset.act === "replay") void replaySession(s);
  else if (b.dataset.act === "remove") {
    state.sessions = state.sessions.filter((x) => x !== s);
    if (state.active === s) state.active = null;
  }
  renderAll();
});

function download(name: string, blob: Blob): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

scroller.addEventListener("scroll", () => renderOverlayNow(), { passive: true });
window.addEventListener("resize", () => renderAll());

// ── rendering ──────────────────────────────────────
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const short = (s: CursorSample | null) => (s ? s.label ?? s.dataSource ?? s.elementPath ?? "?" : "—");

let targets: PointingTarget[] = [];

function renderOverlayNow(): void {
  const a = state.active;
  if (live) {
    // Recording: the live turn's clicks (current scroll; the recorder paints its highlights).
    renderOverlay(layer, scroller, [], [], state.visible, { ...live.events, samples: [], outlineHighlights: false });
    return;
  }
  renderOverlay(layer, scroller, targets, a?.labels ?? [], state.visible,
    a ? { ...sessionEvents(a), samples: a.samples, outlineHighlights: a !== paintedSession } : null);
}

/** `<h3> "Live queries"` with the container muted, for the side panels. */
function refHtml(r: { elementPath: string | null; label: string | null; container?: string | null }, showLabel = true): string {
  const tag = tagFromPath(r.elementPath);
  const label = !showLabel ? "" : r.label ? `“${esc(r.label)}”` : `<span class="muted">(no label)</span>`;
  return `${tag ? `<span class="mono">&lt;${tag}&gt;</span> ` : ""}${label}`
    + (r.container && r.container !== r.label ? ` <span class="muted">in “${esc(r.container)}”</span>` : "");
}

// ── live "Under the cursor" inspector + hover outline ──
let hoverKey = "";
function renderInspector(s: CursorSample): void {
  const el = s.elementPath ? findPath(s.elementPath) : null;
  const comp = el && s.container ? el.parentElement?.closest("[data-label]") ?? null : null;
  renderHover(hoverLayer, scroller, el, comp && demoRoot.contains(comp) ? comp : null);
  const key = `${s.elementPath}|${s.label}|${s.container}|${s.dataSource}`;
  if (key === hoverKey) return;
  hoverKey = key;
  $("inspector").innerHTML = s.elementPath
    ? `<div class="el">${refHtml(s).replace('class="mono"', 'class="tag"')}</div>
      <div class="kv">
        <span>in</span><span>${s.container ? `“${esc(s.container)}”` : "—"}</span>
        <span>source</span><span>${s.dataSource ? esc(s.dataSource) : "—"}</span>
        <span>path</span><span class="muted">${esc(s.elementPath)}</span>
      </div>`
    : `<p class="muted small">Move the pointer over the demo page: titles, table headings, buttons and fields are picked out on their own, with their card/table/form as the container.</p>`;
}
renderInspector({ t: 0, x: 0, y: 0, scrollX: 0, scrollY: 0, elementPath: null, dataSource: null, label: null });

const KIND_NAME = { single: "click", double: "double", triple: "triple", multi: "multi" } as const;

/** "0.9 s" / "0.9, 1.0, 1.2 s" / "0.9–1.6 s (7 clicks)". */
function clickTimes(times: readonly number[], t0: number): string {
  const r = (t: number) => relTime(t, t0) ?? "?";
  if (times.length <= 1) return r(times[0] ?? NaN);
  if (times.length > 6) return `${r(times[0]!).replace(" s", "")}–${r(times[times.length - 1]!)} (${times.length} clicks)`;
  return `${times.map((t) => r(t).replace(" s", "")).join(", ")} s`;
}

/** One row per click event and per highlight; times are seconds from audio start (`t0`, on the events' clock). */
function pageEventsHtml(ev: PageEvents, words: Word[], t0: number, emptyText: string): string {
  const said = (t: number) => {
    const w = wordNear(t, words, t0);
    return w ? ` · while saying <span class="quote">“${esc(w.text.trim())}”</span>` : "";
  };
  const clicks = sortClicks(ev.clicks, Infinity).map((c, i) => `<li>
      <span class="kbadge k-${c.kind}" title="${esc(c.kind)}">${clickBadge(c.count)}<small>${KIND_NAME[c.kind]}</small></span>
      <span class="what"><span class="muted">#${i + 1}</span> ${refHtml(c)}</span>
      <span class="meta">${c.count > 1 ? `${c.count} clicks at <b class="times">${clickTimes(c.times, t0)}</b>` : `at <b class="times">${relTime(c.t, t0) ?? "?"}</b>`}${said(c.t)}</span></li>`);
  const pre = ev.preselected;
  const hls = ev.highlights.map((h, i) => {
    const a = relTime(h.tStart, t0) ?? "?", b = relTime(h.t, t0) ?? "?";
    return `<li><span class="kbadge hl">H${i + 1}<small>made</small></span>
      <span class="what"><span class="quote">“${esc(truncateText(h.text, 120))}”</span> <span class="muted">in</span> ${refHtml(h, false)}</span>
      <span class="meta">${h.via ? `by ${esc(h.via)} · ` : ""}made ${a === b ? `at <b class="times">${a}</b>` : `<b class="times">${a.replace(" s", "")}–${b}</b>`}${said(h.t)}</span></li>`;
  });
  if (!clicks.length && !pre && !hls.length) return `<p class="muted small">${emptyText}</p>`;
  return `<div class="pc-head">Clicks <span>${clicks.length}</span></div>
    <ul class="pc-list">${clicks.join("") || `<li class="empty">No clicks.</li>`}</ul>
    <div class="pc-head">Highlights <span>${hls.length}${pre ? " + 1 already" : ""}</span></div>
    <ul class="pc-list">${pre ? `<li><span class="kbadge pre">pre<small>start</small></span>
      <span class="what"><b>Already highlighted at start:</b> <span class="quote">“${esc(truncateText(pre.text, 120))}”</span> <span class="muted">in</span> ${refHtml(pre, false)}</span></li>` : ""}
    ${hls.join("") || `<li class="empty">No highlights made during the turn.</li>`}</ul>`;
}

function renderPageContext(a: LabSession | null): void {
  if (live) {
    const t0 = live.t.tAudioStart ?? live.t.tPress;
    $("page-ctx-note").textContent = "· recording (live)";
    $("page-ctx").innerHTML = pageEventsHtml(live.events, [], t0, "Click or highlight something on the page while talking…");
    return;
  }
  $("page-ctx-note").textContent = a ? `· ${a.id}, s from audio start` : "";
  const ev = a ? sessionEvents(a) : null;
  $("page-ctx").innerHTML = a && ev ? pageEventsHtml(ev, a.words, 0, "No clicks or highlighted text in this turn.") : `<p class="muted small">—</p>`;

  const ctx = a ? [formatPointingContext(targets), formatPageContext(ev, a.words, 0)].filter(Boolean).join("\n") : "";
  let text = ctx || (a ? "(nothing: no pointing words, clicks or highlights)" : "Record a turn to see the context the LLM gets.");
  const server = a?.serverTargets?.length ? formatPointingContext(a.serverTargets) : "";
  if (server && !ctx.startsWith(server)) text += `\n\nserver sent (preMs/postMs at record time):\n${server}`;
  $("server-ctx").textContent = text;
}

function renderAll(): void {
  const a = state.active;
  targets = a ? resolvePointing(a.words, 0, a.samples, state.opts) : [];
  $("pre-v").textContent = `${state.opts.preMs}`;
  $("post-v").textContent = `${state.opts.postMs}`;
  demoRoot.classList.toggle("labeling", state.labeling !== null);

  $("legend").innerHTML = ALGORITHMS.map((al) =>
    `<label><input type="checkbox" value="${al}" ${state.visible.has(al) ? "checked" : ""}/>
      <i style="background:${colorFor(al)}"></i>${al}</label>`).join("") +
    `<label><i class="label-swatch"></i>labeled target</label>`;

  $("active-id").textContent = a ? `· ${a.id}` : "";
  if (!a) $("picks").innerHTML = `<p class="muted small">No session yet.</p>`;
  else if (!a.labels.length) $("picks").innerHTML = `<p class="muted small">No pointing words in “${esc(a.transcript)}”.</p>`;
  else {
    const rows = a.labels.map((l, n) => {
      const cells = ALGORITHMS.map((al) => {
        const t = targets.find((x) => x.algorithm === al && x.wordStart === a.words[l.wordIndex]!.start && x.word === l.word);
        const ok = l.target && t ? targetMatches(t.sample, l.target) : null;
        return `<td style="border-left:3px solid ${colorFor(al)}" class="${ok === null ? "" : ok ? "ok" : "bad"}">${esc(short(t?.sample ?? null))}</td>`;
      }).join("");
      const armed = state.labeling === l.wordIndex;
      return `<tr><th><span class="muted">[${n + 1}]</span> “${esc(l.word)}” <span class="muted">${l.start.toFixed(2)}s</span></th>${cells}
        <td><button data-label-word="${l.wordIndex}" class="${armed ? "armed" : ""}">${armed ? "click target…" : l.target ? esc(l.target.label ?? "labeled") : "Label"}</button></td></tr>`;
    }).join("");
    $("picks").innerHTML = `<table class="grid"><tr><th></th>${ALGORITHMS.map((al) => `<th>${al}</th>`).join("")}<th>label</th></tr>${rows}</table>`;
  }
  renderPageContext(a);

  $("sessions").innerHTML = state.sessions.length
    ? `<table class="grid">${state.sessions.map((s) => {
      const n = s.labels.filter((l) => l.target).length;
      return `<tr class="${s === a ? "active" : ""}"><td class="mono">${esc(s.id)}</td><td>${esc(s.transcript)}</td>
        <td class="muted">${n}/${s.labels.length} labeled</td>
        <td><button data-act="view" data-id="${esc(s.id)}">view</button>
        ${s.wav ? `<button data-act="replay" data-id="${esc(s.id)}" title="Replay WAV + cursor through Scribe">replay</button>` : ""}
        <button data-act="remove" data-id="${esc(s.id)}">×</button></td></tr>`;
    }).join("")}</table>`
    : `<p class="muted small">Record a turn or load saved files.</p>`;

  const sc = scoreSessions(state.sessions, state.opts);
  const scored = state.sessions.filter((s) => s.labels.some((l) => l.target));
  $("accuracy").innerHTML = scored.length
    ? `<table class="grid"><tr><th>algorithm</th><th>all</th>${scored.map((s) => `<th class="mono">${esc(s.id)}</th>`).join("")}</tr>
      ${sc.algorithms.map((al) => `<tr><th style="border-left:3px solid ${colorFor(al)}">${al}</th>
        <td><b>${pct(sc.overall[al]!)}</b> <span class="muted">${sc.overall[al]!.correct}/${sc.overall[al]!.total}</span></td>
        ${scored.map((s) => { const t = sc.perSession[s.id]![al]!; return `<td>${t.correct}/${t.total}</td>`; }).join("")}</tr>`).join("")}
      </table><p class="muted small">At preMs=${state.opts.preMs}, postMs=${state.opts.postMs}. Match = same data-source (else same element path).</p>`
    : `<p class="muted small">Label pointing words (Picks → Label, then click the element) to score.</p>`;

  renderOverlayNow();
  drawTimeline(canvas, a ? buildTimelineModel(a.samples, a.words, targets, state.opts, 0, sessionEvents(a)) : null, state.visible);
}
