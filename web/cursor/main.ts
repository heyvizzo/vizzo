// Cursor lab (TASKS T9, PRD FR7–FR13).
import "./cursor.css";
import { connectWithStatus } from "../common.ts";
import { DEFAULT_CONFIG, type RunConfig } from "../../shared/config.ts";
import { ALGORITHMS, formatPointingContext, resolvePointing, type WindowOpts } from "../../shared/pointing.ts";
import type { CursorSample, PointingTarget, ServerMsg } from "../../shared/protocol.ts";
import { startCapture, type CaptureHandle } from "../audio/capture.ts";
import { bindPushToTalk } from "../audio/ptt.ts";
import { createWavRecorder, type WavRecorder } from "../audio/record.ts";
import { startReplay, type ReplayHandle } from "../audio/replay.ts";
import { colorFor } from "./colors.ts";
import { mountDemo } from "./demoLoader.ts";
import { describeElement } from "./dom.ts";
import { renderOverlay } from "./overlay.ts";
import { Sampler } from "./sampler.ts";
import { pct, scoreSessions, targetMatches } from "./scoring.ts";
import {
  labelsFor, nextSessionId, sessionsFromFiles, toCursorFile, toLabelsFile, toRelativeSamples, type LabSession, type LoadedFile,
} from "./session.ts";
import { buildTimelineModel, drawTimeline } from "./timeline.ts";

const PRE_ROLL_MS = 500; // cursor history sent/saved from before the press
const POST_ROLL_MS = 300; // and kept after the release
const BATCH_MS = 100;

const app = document.getElementById("app")!;
app.classList.add("cursor-lab");
app.innerHTML = `
<div class="cl-demo" id="demo-scroller">
  <div id="demo-root"></div>
  <div id="ov-layer" aria-hidden="true"></div>
</div>
<aside class="cl-side">
  <section class="panel">
    <div class="row">
      <button id="ptt" class="ptt">Hold to talk <span class="muted">(or Space)</span></button>
      <span id="turn-status" class="muted"></span>
    </div>
    <p id="transcript" class="transcript muted">Point at something on the page and say e.g. “move this over there”.</p>
    <p id="latency" class="muted mono small"></p>
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
    <pre id="server-ctx" class="mono small muted"></pre>
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
}
let turn: Turn | null = null;

const sock = connectWithStatus();
const sampler = new Sampler(demoRoot, scroller);

// ── demo page ──────────────────────────────────────
void mountDemo(demoRoot).then((info) => {
  if (info.source === "fallback") $("turn-status").textContent = "using built-in fallback demo";
  sampler.start();
  renderAll();
});

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
  $("ptt").classList.remove("live");
  await t.audioStarted;
  t.capture?.stop();
  if (turn !== t) return;
  flushSamples(t);
  clearInterval(t.batchTimer);
  sock.send({ type: "turn.release", turnId: t.turnId, tRelease: t.tRelease });
  setStatus("transcribing…");
}

function failTurn(t: Turn, msg: string): void {
  clearInterval(t.batchTimer);
  t.capture?.stop();
  t.replay?.stop();
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
  renderOverlay(layer, scroller, targets, state.active?.labels ?? [], state.visible);
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
    const rows = a.labels.map((l) => {
      const cells = ALGORITHMS.map((al) => {
        const t = targets.find((x) => x.algorithm === al && x.wordStart === a.words[l.wordIndex]!.start && x.word === l.word);
        const ok = l.target && t ? targetMatches(t.sample, l.target) : null;
        return `<td style="border-left:3px solid ${colorFor(al)}" class="${ok === null ? "" : ok ? "ok" : "bad"}">${esc(short(t?.sample ?? null))}</td>`;
      }).join("");
      const armed = state.labeling === l.wordIndex;
      return `<tr><th>“${esc(l.word)}” <span class="muted">${l.start.toFixed(2)}s</span></th>${cells}
        <td><button data-label-word="${l.wordIndex}" class="${armed ? "armed" : ""}">${armed ? "click target…" : l.target ? esc(l.target.label ?? "labeled") : "Label"}</button></td></tr>`;
    }).join("");
    $("picks").innerHTML = `<table class="grid"><tr><th></th>${ALGORITHMS.map((al) => `<th>${al}</th>`).join("")}<th>label</th></tr>${rows}</table>`;
  }
  $("server-ctx").textContent = a?.serverTargets?.length ? `server (dwellMode):\n${formatPointingContext(a.serverTargets)}` : "";

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
  drawTimeline(canvas, a ? buildTimelineModel(a.samples, a.words, targets, state.opts) : null, state.visible);
}
