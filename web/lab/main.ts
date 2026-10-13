// Latency lab (TASKS T8, PRD FR1–FR6): config, live mic / fixture replay turns, N-run benchmark, live turn view,
import { isMarkedSegment } from "../../shared/marks.ts";
// per-turn waterfall, results table, export, past runs. All untrusted strings go through textContent.
import "./lab.css";
import { connectWithStatus } from "../common.ts";
import { DEFAULT_CONFIG, type Approach, type RunConfig } from "../../shared/config.ts";
import { CLIENT_MARKS, type MarkName } from "../../shared/marks.ts";
import type { CursorSample, PointingTarget, RunRecord, Segment, ServerMsg } from "../../shared/protocol.ts";
import { startCapture, type CaptureHandle } from "../audio/capture.ts";
import { warmUpAudio } from "../audio/context.ts";
import { createPlayer, type Player } from "../audio/player.ts";
import { bindPushToTalk } from "../audio/ptt.ts";
import { startReplay, type ReplayHandle } from "../audio/replay.ts";
import { Sampler } from "../cursor/sampler.ts";
import { filesFromInput, fixtureWav, fixturesFromFiles, loadServerFixtures, type Fixture } from "./fixtures.ts";
import type { LabSocketLike } from "./socket.ts";
import {
  TABLE_METRICS, mergeRun, normalizeRun, summaryTable, toCsv, variantKey, type GroupBy, type TableMetric,
} from "./stats.ts";
import { buildWaterfall, renderVendorLegend, renderWaterfall } from "./waterfall.ts";

const PRE_ROLL_MS = 500;
const BATCH_MS = 100;
const DONE_TIMEOUT_MS = 45_000; // after release
const APPROACHES = ["realtime", "pipeline", "hybrid"] as const satisfies readonly Approach[];
const APPROACH_LABEL: Record<string, string> = { realtime: "A · realtime", pipeline: "B · pipeline", hybrid: "C · hybrid" };
const STORE_KEY = "latencyLab.settings.v1";
const FAKE = new URLSearchParams(location.search).has("fake");

// ── settings (localStorage, best effort) ────────────
interface Settings {
  config: RunConfig;
  source: "mic" | "fixture";
  fixtureId: string;
  n: number;
  cooldownMs: number;
  allApproaches: boolean;
  groupBy: GroupBy;
}
const DEFAULT_SETTINGS: Settings = {
  config: { ...DEFAULT_CONFIG }, source: "fixture", fixtureId: "", n: 10, cooldownMs: 1500, allApproaches: false, groupBy: "approach",
};
function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const s = JSON.parse(raw) as Partial<Settings>;
    const config = { ...DEFAULT_CONFIG, ...(s.config ?? {}) };
    if (!(APPROACHES as readonly string[]).includes(config.approach)) config.approach = DEFAULT_CONFIG.approach;
    return { ...DEFAULT_SETTINGS, ...s, config };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}
const settings = loadSettings();
function saveSettings(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings));
  } catch { /* storage unavailable */ }
}

// ── markup ──────────────────────────────────────────
const app = document.getElementById("app")!;
app.classList.add("lab");
app.innerHTML = `
<aside class="lab-side">
  <section class="panel">
    <h3>Configuration</h3>
    <div class="seg" id="approach" role="radiogroup" aria-label="Approach">
      ${APPROACHES.map((a) => `<label><input type="radio" name="approach" value="${a}" /><span>${APPROACH_LABEL[a]}</span></label>`).join("")}
    </div>
    <div class="form">
      <label data-for="realtime hybrid">Realtime model
        <select data-k="realtimeModel"><option>gpt-realtime-2.1</option><option>gpt-realtime-2.1-mini</option></select></label>
      <label data-for="pipeline">Router mode
        <select data-k="routerMode"><option value="forced">forced (tool_choice)</option><option value="auto">auto</option></select></label>
      <label data-for="pipeline">TTS model
        <select data-k="ttsModel"><option>eleven_v4_turbo</option><option>eleven_flash_v2_5</option></select></label>
      <label data-for="realtime pipeline hybrid">Claude backend
        <select data-k="claudeBackend"><option value="cli">claude -p agents</option><option value="api">API (OpenRouter)</option></select></label>
      <label data-for="hybrid">Hybrid wait (ms)
        <input data-k="hybridWaitMs" type="number" min="0" max="5000" step="50" /></label>
      <label data-for="pipeline hybrid">Pointing preMs
        <input data-k="preMs" type="number" min="0" max="3000" step="25" /></label>
      <label data-for="pipeline hybrid">Pointing postMs
        <input data-k="postMs" type="number" min="0" max="3000" step="25" /></label>
      <label class="check"><input data-k="opusFast" type="checkbox" /> Opus fast mode</label>
      <label class="check"><input data-k="prewarm" type="checkbox" /> Pre-warm vendor sockets</label>
    </div>
    <p class="muted small" id="variant"></p>
  </section>

  <section class="panel">
    <h3>Input</h3>
    <div class="seg" id="source" role="radiogroup" aria-label="Input source">
      <label><input type="radio" name="source" value="fixture" /><span>Recorded fixture</span></label>
      <label><input type="radio" name="source" value="mic" /><span>Live mic</span></label>
    </div>
    <div id="src-mic" class="stack">
      <button id="mic-enable">Enable mic &amp; audio</button>
      <button id="ptt" class="ptt" disabled>Hold to talk <span class="muted">(or Space)</span></button>
    </div>
    <div id="src-fixture" class="stack">
      <div class="row">
        <select id="fixture" aria-label="Fixture"></select>
        <label class="file-btn" title="Uxx.wav + optional Uxx.cursor.json + Uxx.labels.json">Load files…<input id="fx-files" type="file" multiple accept=".wav,.json" hidden /></label>
      </div>
      <p id="fx-info" class="muted small"></p>
      <button id="run-once">Run once</button>
    </div>
    <p id="fx-errors" class="err small"></p>
  </section>

  <section class="panel">
    <h3>Benchmark</h3>
    <div class="form two">
      <label>Runs (N)<input id="n" type="number" min="1" max="500" /></label>
      <label>Cooldown (ms)<input id="cooldown" type="number" min="0" max="60000" step="100" /></label>
    </div>
    <label class="check"><input id="all-approaches" type="checkbox" /> All approaches (A, B, C × N)</label>
    <div class="row">
      <button id="run-n" class="primary">Run N</button>
      <button id="stop" disabled>Stop</button>
    </div>
    <div class="progress" aria-hidden="true"><i id="progress-bar"></i></div>
    <p id="progress" class="muted small"></p>
  </section>
</aside>

<div class="lab-main">
  <section class="panel turn">
    <div class="panel-head"><h3 id="turn-title">Current turn</h3><span id="turn-status" class="status muted"></span></div>
    <dl class="turn-fields">
      <dt>Transcript</dt><dd id="t-transcript" class="text"></dd>
      <dt>Pointing</dt><dd id="t-pointing"></dd>
      <dt>Voice</dt><dd id="t-voice" class="text"></dd>
      <dt>Opus</dt><dd id="t-opus" class="text opus"></dd>
      <dt>Errors</dt><dd id="t-errors" class="text err"></dd>
    </dl>
  </section>

  <section class="panel wf">
    <div class="panel-head"><h3>Waterfall <span class="muted small" id="wf-sub"></span></h3><div id="wf-legend" class="vlegend"></div></div>
    <div id="waterfall"></div>
    <p class="muted small">ms from key release (t = 0). Faint = streaming before release / waiting for first token. Hover a row for details.</p>
  </section>

  <section class="panel results">
    <div class="panel-head">
      <h3>Results</h3>
      <div class="row">
        <label class="inline">Group by <select id="group-by"><option value="approach">approach</option><option value="variant">config variant</option></select></label>
        <label class="inline">Fixture <select id="fx-filter"></select></label>
      </div>
    </div>
    <div class="table-wrap"><table class="stats" id="stats"></table></div>
    <p class="muted small">ms from release (cost in USD). p50/p90 use linear interpolation. Bold = lowest p50 in the row. A small n means the metric only applies to some runs (e.g. tool calls).</p>
  </section>

  <section class="panel runs">
    <div class="panel-head">
      <h3>Runs <span id="runs-count" class="muted small"></span></h3>
      <div class="row">
        <button id="load-past">Load past runs</button>
        <button id="export-json">Export JSON</button>
        <button id="export-csv">Export CSV</button>
        <button id="clear-runs">Clear</button>
      </div>
    </div>
    <div class="table-wrap runs-wrap"><table class="runs-table" id="runs"></table></div>
  </section>
</div>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ── socket ──────────────────────────────────────────
const fixtures: Fixture[] = [];
let sock: LabSocketLike;
if (FAKE) {
  const { FakeSocket, fakeFixture } = await import("./fake.ts");
  sock = new FakeSocket();
  const clock = $("clock");
  clock.textContent = "FAKE socket (?fake=1) · no server";
  clock.dataset.status = "connected";
  fixtures.push(fakeFixture());
} else {
  sock = connectWithStatus();
}

// ── state ───────────────────────────────────────────
interface ActiveTurn {
  turnId: string;
  config: RunConfig;
  fixtureId?: string;
  marks: Partial<Record<MarkName, number>>; // client marks + server marks (client time)
  clientMarks: Partial<Record<MarkName, number>>;
  tAudioStart?: number;
  released: boolean;
  capture?: CaptureHandle;
  replay?: ReplayHandle;
  injected?: CursorSample[];
  sentUpTo: number;
  batchTimer?: ReturnType<typeof setInterval>;
  doneTimer?: ReturnType<typeof setTimeout>;
  partial: string;
  transcript: string;
  pointing: PointingTarget[];
  voice: string;
  opus: string;
  errors: string[];
  finish: (r: RunRecord | null) => void;
  done: Promise<RunRecord | null>;
}

let runs: RunRecord[] = [];
let turn: ActiveTurn | null = null;
let selectedRunId: string | null = null;
let bench: { stop: boolean } | null = null;
let player: Player | null = null;
let playerPromise: Promise<Player> | null = null;
let micReady = false;

const sampler = new Sampler(document.body, (document.scrollingElement ?? document.documentElement) as HTMLElement);
sampler.start();

// ── config controls ─────────────────────────────────
function syncControls(): void {
  const c = settings.config;
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="approach"]')) r.checked = r.value === c.approach;
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="source"]')) r.checked = r.value === settings.source;
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-k]")) {
    const k = el.dataset.k as keyof RunConfig;
    if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = Boolean(c[k]);
    else el.value = String(c[k]);
  }
  for (const l of document.querySelectorAll<HTMLElement>("label[data-for]")) l.classList.toggle("irrelevant", !l.dataset.for!.split(" ").includes(c.approach));
  $<HTMLInputElement>("n").value = String(settings.n);
  $<HTMLInputElement>("cooldown").value = String(settings.cooldownMs);
  $<HTMLInputElement>("all-approaches").checked = settings.allApproaches;
  $<HTMLSelectElement>("group-by").value = settings.groupBy;
  $("variant").textContent = `Variant: ${variantKey(c)}`;
  $("src-mic").hidden = settings.source !== "mic";
  $("src-fixture").hidden = settings.source !== "fixture";
}

$("approach").addEventListener("change", (e) => {
  settings.config.approach = (e.target as HTMLInputElement).value as Approach;
  saveSettings();
  syncControls();
});
$("source").addEventListener("change", (e) => {
  settings.source = (e.target as HTMLInputElement).value as Settings["source"];
  saveSettings();
  syncControls();
});
app.addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement | HTMLSelectElement;
  const k = el.dataset.k as keyof RunConfig | undefined;
  if (!k) return;
  const c = settings.config as unknown as Record<string, unknown>;
  if (el instanceof HTMLInputElement && el.type === "checkbox") c[k] = el.checked;
  else if (el instanceof HTMLInputElement && el.type === "number") {
    const v = Number(el.value);
    c[k] = Number.isFinite(v) && v >= 0 ? v : (DEFAULT_CONFIG as unknown as Record<string, unknown>)[k];
  } else c[k] = el.value;
  saveSettings();
  syncControls();
});
const numSetting = (id: string, key: "n" | "cooldownMs", min: number) =>
  $(id).addEventListener("change", (e) => {
    const v = Math.round(Number((e.target as HTMLInputElement).value));
    settings[key] = Number.isFinite(v) && v >= min ? v : DEFAULT_SETTINGS[key];
    saveSettings();
    syncControls();
  });
numSetting("n", "n", 1);
numSetting("cooldown", "cooldownMs", 0);
$("all-approaches").addEventListener("change", (e) => {
  settings.allApproaches = (e.target as HTMLInputElement).checked;
  saveSettings();
});

// ── fixtures ────────────────────────────────────────
function upsertFixtures(list: Fixture[]): void {
  for (const f of list) {
    const i = fixtures.findIndex((x) => x.id === f.id);
    if (i >= 0) fixtures[i] = f;
    else fixtures.push(f);
  }
  fixtures.sort((a, b) => a.id.localeCompare(b.id));
  renderFixtures();
}

function currentFixture(): Fixture | null {
  return fixtures.find((f) => f.id === settings.fixtureId) ?? fixtures[0] ?? null;
}

function renderFixtures(): void {
  const sel = $<HTMLSelectElement>("fixture");
  sel.replaceChildren(...fixtures.map((f) => new Option(`${f.id}${f.origin === "server" ? "" : f.origin === "fake" ? " (fake)" : " (file)"}`, f.id)));
  if (!fixtures.length) sel.append(new Option("no fixtures: load files", ""));
  const fx = currentFixture();
  if (fx) sel.value = fx.id;
  $("fx-info").textContent = fx
    ? `${fx.transcript ? `“${fx.transcript}” · ` : ""}${fx.samples.length} cursor samples · ${fx.pointingWords} pointing word(s)${fx.labeled ? `, ${fx.labeled} labeled` : ""}`
    : "Load Uxx.wav (+ Uxx.cursor.json, Uxx.labels.json), or add them to fixtures/utterances/.";
}

$("fixture").addEventListener("change", (e) => {
  settings.fixtureId = (e.target as HTMLSelectElement).value;
  saveSettings();
  renderFixtures();
});
$<HTMLInputElement>("fx-files").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const { fixtures: list, errors } = fixturesFromFiles(await filesFromInput(input.files));
  input.value = "";
  $("fx-errors").textContent = errors.join("\n");
  if (list[0]) settings.fixtureId = list[0].id;
  upsertFixtures(list);
  saveSettings();
});
void loadServerFixtures()
  .then(({ fixtures: list, errors }) => {
    upsertFixtures(list);
    if (errors.length) $("fx-errors").textContent = errors.join("\n");
  })
  .catch((e: Error) => {
    if (!FAKE) console.warn("[lab] fixtures", e);
    renderFixtures();
  });

// ── audio ───────────────────────────────────────────
function ensurePlayer(): Promise<Player> {
  playerPromise ??= createPlayer().then((p) => {
    player = p;
    p.onPlayed = (seg, tPlayed) => onPlayed(seg, tPlayed);
    return p;
  }).catch((e) => {
    playerPromise = null;
    throw e;
  });
  return playerPromise;
}

function onPlayed(seg: Segment, tPlayed: number): void {
  const t = turn;
  if (!t || !isMarkedSegment(seg)) return;
  const name: MarkName = `${seg}.played`;
  if (t.clientMarks[name] !== undefined) return;
  t.clientMarks[name] = tPlayed;
  t.marks[name] = tPlayed;
  sock.send({ type: "audio.played", turnId: t.turnId, segment: seg, tPlayed });
  scheduleRender();
}

sock.onAudio((pcm) => {
  if (turn) player?.push(pcm);
});

$("mic-enable").addEventListener("click", async () => {
  const b = $<HTMLButtonElement>("mic-enable");
  b.disabled = true;
  b.textContent = "Enabling…";
  try {
    await warmUpAudio();
    await ensurePlayer();
    micReady = true;
    b.textContent = "Mic ready";
    $<HTMLButtonElement>("ptt").disabled = false;
  } catch (e) {
    b.disabled = false;
    b.textContent = "Enable mic & audio";
    setStatus(`mic: ${(e as Error).message}`);
  }
});

// ── turn flow ───────────────────────────────────────
function setStatus(s: string): void {
  $("turn-status").textContent = s;
}

function beginTurn(config: RunConfig, fixtureId?: string, injected?: CursorSample[]): ActiveTurn {
  const tPress = performance.now();
  let finish!: (r: RunRecord | null) => void;
  const done = new Promise<RunRecord | null>((r) => (finish = r));
  const t: ActiveTurn = {
    turnId: crypto.randomUUID(), config: structuredClone(config), fixtureId, marks: { press: tPress }, clientMarks: { press: tPress },
    released: false, injected, sentUpTo: injected ? -Infinity : tPress - PRE_ROLL_MS - 1,
    partial: "", transcript: "", pointing: [], voice: "", opus: "", errors: [], finish, done,
  };
  t.finish = (r) => {
    clearInterval(t.batchTimer);
    clearTimeout(t.doneTimer);
    t.capture?.stop();
    t.replay?.stop();
    sampler.paused = false;
    if (turn === t) turn = null;
    finish(r);
    updateButtons();
  };
  player?.reset();
  turn = t;
  selectedRunId = null;
  sock.send({ type: "turn.start", turnId: t.turnId, config: t.config, tPress, ...(fixtureId ? { fixtureId } : {}) });
  t.batchTimer = setInterval(() => flushSamples(t), BATCH_MS);
  updateButtons();
  renderView();
  return t;
}

function turnSamples(t: ActiveTurn): CursorSample[] {
  return t.injected ?? sampler.range(t.marks.press! - PRE_ROLL_MS);
}

function flushSamples(t: ActiveTurn): void {
  const fresh = turnSamples(t).filter((s) => s.t > t.sentUpTo);
  if (!fresh.length) return;
  t.sentUpTo = fresh[fresh.length - 1]!.t;
  sock.send({ type: "cursor.samples", turnId: t.turnId, samples: fresh });
}

function onFrame(t: ActiveTurn, pcm: Int16Array<ArrayBuffer>): void {
  if (turn === t && !t.released) sock.sendAudio(pcm);
}

function audioStarted(t: ActiveTurn, tAudioStart: number): void {
  t.tAudioStart = tAudioStart;
  sock.send({ type: "turn.audioStart", turnId: t.turnId, tAudioStart });
}

function releaseTurn(t: ActiveTurn): void {
  if (t.released || turn !== t) return;
  const tRelease = performance.now();
  t.released = true;
  t.marks.release = tRelease;
  t.clientMarks.release = tRelease;
  flushSamples(t);
  clearInterval(t.batchTimer);
  sock.send({ type: "turn.release", turnId: t.turnId, tRelease });
  setStatus("waiting for reply…");
  t.doneTimer = setTimeout(() => {
    t.errors.push(`no turn.done within ${DONE_TIMEOUT_MS / 1000} s`);
    sock.send({ type: "turn.cancel", turnId: t.turnId });
    t.finish(null);
    renderView();
  }, DONE_TIMEOUT_MS);
  scheduleRender();
}

function cancelTurn(t: ActiveTurn, why: string): void {
  sock.send({ type: "turn.cancel", turnId: t.turnId });
  player?.reset();
  t.errors.push(why);
  setStatus(why);
  t.finish(null);
  renderView();
}

// Live mic: press/release.
let micTurn: ActiveTurn | null = null;
async function pressLive(): Promise<void> {
  if (settings.source !== "mic" || turn || bench) return;
  if (!micReady) return setStatus("click “Enable mic & audio” first");
  if (!sock.isOpen) return setStatus("server not connected");
  const t = beginTurn(settings.config);
  micTurn = t;
  $("ptt").classList.add("live");
  setStatus("listening…");
  try {
    t.capture = await startCapture({ onFrame: (pcm) => onFrame(t, pcm) });
    audioStarted(t, await t.capture.tAudioStart);
  } catch (e) {
    cancelTurn(t, `mic: ${(e as Error).message}`);
  }
  void t.done.then((r) => r && addRun(r));
}
async function releaseLive(): Promise<void> {
  $("ptt").classList.remove("live");
  const t = micTurn;
  micTurn = null;
  if (!t || turn !== t) return;
  // Release only once tAudioStart is known, so audioStart precedes release on the wire.
  while (t.tAudioStart === undefined && turn === t) await new Promise((r) => setTimeout(r, 5));
  t.capture?.stop();
  releaseTurn(t);
}
try {
  bindPushToTalk({ button: $("ptt"), onPress: () => void pressLive(), onRelease: () => void releaseLive() });
} catch (e) {
  setStatus(`push-to-talk unavailable: ${(e as Error).message}`);
}

/** Replay one fixture through a full turn; resolves with the merged RunRecord (null on failure/cancel). */
async function replayTurn(fx: Fixture, config: RunConfig): Promise<RunRecord | null> {
  if (!sock.isOpen) {
    setStatus("server not connected");
    return null;
  }
  let wav: ArrayBuffer;
  try {
    wav = await fixtureWav(fx);
    await ensurePlayer().catch((e: Error) => console.warn("[lab] player unavailable", e));
  } catch (e) {
    setStatus(`${fx.id}: ${(e as Error).message}`);
    return null;
  }
  sampler.paused = true;
  const injected: CursorSample[] = [];
  const t = beginTurn(config, fx.id, injected);
  setStatus(`replaying ${fx.id} · ${APPROACH_LABEL[config.approach] ?? config.approach}…`);
  try {
    t.replay = startReplay({ wav, cursor: fx.samples, onFrame: (pcm) => onFrame(t, pcm), onCursor: (c) => void injected.push(c) });
    audioStarted(t, await t.replay.tAudioStart);
    await t.replay.done;
  } catch (e) {
    cancelTurn(t, `replay: ${(e as Error).message}`);
    return t.done;
  }
  sampler.paused = false;
  releaseTurn(t);
  const r = await t.done;
  if (r) addRun(r);
  return r;
}

sock.on((msg: ServerMsg) => {
  const t = turn;
  if (msg.type === "error" && (!msg.turnId || !t || msg.turnId !== t.turnId)) {
    if (!msg.turnId) setStatus(`error (${msg.source}): ${msg.message}`);
    return;
  }
  if (!t || !("turnId" in msg) || msg.turnId !== t.turnId) return;
  switch (msg.type) {
    case "mark":
      if (!CLIENT_MARKS.has(msg.name)) t.marks[msg.name] = sock.toClientTime(msg.serverNow);
      break;
    case "stt.partial":
      t.partial = msg.text;
      break;
    case "stt.final":
      t.transcript = msg.text;
      break;
    case "pointing.resolved":
      t.pointing = msg.targets;
      break;
    case "voice.text":
      t.voice += msg.delta;
      break;
    case "opus.text":
      t.opus += msg.delta;
      break;
    case "audio.segment":
      if (msg.state === "start") player?.startSegment(msg.segment);
      else player?.endSegment(msg.segment);
      break;
    case "error":
      t.errors.push(`${msg.source}: ${msg.message}`);
      break;
    case "turn.done": {
      const run = mergeRun(msg.run, t.clientMarks);
      if (!run.fixtureId && t.fixtureId) run.fixtureId = t.fixtureId;
      setStatus(run.error ? `done with error: ${run.error}` : `done · TTFA ${fmtMs(run.metrics.ttfa)} · TTA ${fmtMs(run.metrics.tta)}`);
      t.finish(run);
      selectedRunId = run.runId;
      break;
    }
  }
  scheduleRender();
});

function addRun(r: RunRecord): void {
  if (runs.some((x) => x.runId === r.runId)) return;
  runs.push(r);
  selectedRunId = r.runId;
  renderRuns();
  renderResults();
  renderView();
}

$("run-once").addEventListener("click", () => {
  const fx = currentFixture();
  if (!fx) return setStatus("no fixture selected");
  if (turn || bench) return;
  void replayTurn(fx, settings.config);
});

// ── benchmark ───────────────────────────────────────
$("run-n").addEventListener("click", async () => {
  const fx = currentFixture();
  if (!fx) return setStatus("no fixture selected");
  if (turn || bench) return;
  const b = { stop: false };
  bench = b;
  updateButtons();
  const approaches: Approach[] = settings.allApproaches ? [...APPROACHES] : [settings.config.approach];
  const total = approaches.length * settings.n;
  let i = 0;
  let ok = 0;
  outer: for (const approach of approaches) {
    for (let k = 0; k < settings.n; k++) {
      if (b.stop) break outer;
      progress(i, total, `${APPROACH_LABEL[approach]} · run ${k + 1}/${settings.n}`);
      const r = await replayTurn(fx, { ...settings.config, approach });
      if (r && !r.error) ok++;
      i++;
      if (b.stop || i >= total) break outer;
      progress(i, total, `cooldown ${settings.cooldownMs} ms`);
      await sleep(settings.cooldownMs, b);
    }
  }
  progress(i, total, `${b.stop ? "stopped" : "finished"}: ${i}/${total} runs, ${ok} ok`);
  bench = null;
  updateButtons();
});

$("stop").addEventListener("click", () => {
  if (bench) bench.stop = true;
  if (turn) cancelTurn(turn, "stopped");
  updateButtons();
});

function sleep(ms: number, b: { stop: boolean }): Promise<void> {
  return new Promise((resolve) => {
    const end = performance.now() + ms;
    const tick = () => (b.stop || performance.now() >= end ? resolve() : setTimeout(tick, Math.min(100, end - performance.now())));
    tick();
  });
}

function progress(i: number, total: number, text: string): void {
  $("progress").textContent = `${i}/${total} · ${text}`;
  $("progress-bar").style.width = `${total ? (100 * i) / total : 0}%`;
}

function updateButtons(): void {
  const busy = Boolean(turn || bench);
  $<HTMLButtonElement>("run-n").disabled = busy;
  $<HTMLButtonElement>("run-once").disabled = busy;
  $<HTMLButtonElement>("stop").disabled = !busy;
}

// ── rendering ───────────────────────────────────────
const fmtMs = (v: number | null | undefined): string => (v === null || v === undefined ? "–" : `${Math.round(v)} ms`);
function fmtMetric(m: TableMetric, v: number | null): string {
  if (v === null) return "–";
  return m === "costUsd" ? `$${v.toFixed(4)}` : String(Math.round(v));
}

let renderQueued = false;
function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderView();
  });
}
// Keep open bars growing while a turn is live.
setInterval(() => turn && scheduleRender(), 100);

interface ViewData {
  title: string;
  status?: string;
  approach: Approach;
  marks: Partial<Record<MarkName, number>>;
  transcript: string;
  partial: boolean;
  pointing: PointingTarget[];
  voice: string;
  opus: string;
  errors: string[];
  live: boolean;
  index?: number;
}

function viewData(): ViewData | null {
  const t = turn;
  if (t && !selectedRunId) {
    return {
      title: `Current turn · ${APPROACH_LABEL[t.config.approach] ?? t.config.approach}${t.fixtureId ? ` · ${t.fixtureId}` : ""}`,
      approach: t.config.approach, marks: t.marks, transcript: t.transcript || t.partial, partial: !t.transcript,
      pointing: t.pointing, voice: t.voice, opus: t.opus, errors: t.errors, live: true,
    };
  }
  const r = runs.find((x) => x.runId === selectedRunId) ?? (t ? null : runs[runs.length - 1]);
  if (!r) return null;
  const idx = runs.indexOf(r) + 1;
  return {
    title: `Run #${idx} · ${variantKey(r.config)}${r.fixtureId ? ` · ${r.fixtureId}` : ""}`,
    approach: r.approach, marks: r.marks, transcript: r.transcript, partial: false, pointing: r.pointing ?? [],
    voice: r.voiceText, opus: r.opusText, errors: r.error ? [r.error] : [], live: false, index: idx,
    status: `${r.error ? "error" : "ok"} · TTFA ${fmtMs(r.metrics.ttfa)} · TTA ${fmtMs(r.metrics.tta)} · $${(r.costUsd ?? 0).toFixed(4)}`,
  };
}

function renderView(): void {
  const v = viewData();
  $("turn-title").textContent = v?.title ?? "Current turn";
  const tr = $("t-transcript");
  tr.textContent = v?.transcript || "–";
  tr.classList.toggle("muted", !v?.transcript || v.partial);
  $("t-voice").textContent = v?.voice || "–";
  $("t-opus").textContent = v?.opus || "–";
  $("t-errors").textContent = v?.errors.length ? v.errors.join("\n") : "–";
  $("t-errors").classList.toggle("muted", !v?.errors.length);
  renderPointing($("t-pointing"), v?.pointing ?? []);
  $("wf-sub").textContent = v ? (v.live ? "· live" : `· run #${v.index}`) : "";
  if (v && !v.live && v.status !== undefined) setStatus(v.status);
  renderWaterfall($("waterfall"), v ? buildWaterfall(v.marks, v.approach, v.live ? performance.now() : undefined) : { rows: [], refs: [], min: 0, max: 1, ticks: [] });
}

function renderPointing(host: HTMLElement, targets: PointingTarget[]): void {
  host.replaceChildren();
  if (!targets.length) {
    host.textContent = "–";
    return;
  }
  // One line per pointing word: the dwellMode pick (what the LLM gets), others in the tooltip.
  const byWord = new Map<string, PointingTarget[]>();
  for (const p of targets) {
    const k = `${p.word}@${p.wordStart}`;
    byWord.set(k, [...(byWord.get(k) ?? []), p]);
  }
  for (const list of byWord.values()) {
    const main = list.find((p) => p.algorithm === "dwellMode") ?? list[0]!;
    const line = document.createElement("div");
    line.className = "pt";
    const w = document.createElement("b");
    w.textContent = `“${main.word}”`;
    const s = main.sample;
    const what = document.createElement("span");
    what.textContent = s ? ` → ${s.label ?? s.elementPath ?? "?"}${s.dataSource ? ` [${s.dataSource}]` : ""}` : " → (nothing)";
    const meta = document.createElement("span");
    meta.className = "muted small";
    meta.textContent = ` @ ${main.wordStart.toFixed(2)} s · ${main.algorithm}`;
    line.title = list.map((p) => `${p.algorithm}: ${p.sample?.label ?? p.sample?.elementPath ?? "(nothing)"}`).join("\n");
    line.append(w, what, meta);
    host.append(line);
  }
}

function renderRuns(): void {
  $("runs-count").textContent = runs.length ? `(${runs.length})` : "";
  const table = $("runs");
  const head = document.createElement("thead");
  head.innerHTML = `<tr><th>#</th><th>Fixture</th><th>Variant</th><th class="num">TTFA</th><th class="num">TTA</th><th class="num">STT</th><th class="num">Cost</th><th>Status</th></tr>`;
  const body = document.createElement("tbody");
  runs.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.dataset.runId = r.runId;
    tr.tabIndex = 0;
    if (r.runId === selectedRunId) tr.classList.add("selected");
    const cells = [String(i + 1), r.fixtureId ?? "live", variantKey(r.config), fmtMs(r.metrics.ttfa), fmtMs(r.metrics.tta), fmtMs(r.metrics.stt),
      `$${(r.costUsd ?? 0).toFixed(4)}`, r.error ? `error: ${r.error}` : "ok"];
    cells.forEach((c, j) => {
      const td = document.createElement("td");
      td.textContent = c;
      if (j >= 3 && j <= 6) td.className = "num";
      if (j === 7 && r.error) td.className = "err";
      tr.append(td);
    });
    body.prepend(tr); // newest first
  });
  table.replaceChildren(head, body);
  renderFixtureFilter();
}

function selectRunFromEvent(e: Event): void {
  const tr = (e.target as HTMLElement).closest<HTMLTableRowElement>("tr[data-run-id]");
  if (!tr) return;
  selectedRunId = tr.dataset.runId!;
  for (const row of $("runs").querySelectorAll("tr.selected")) row.classList.remove("selected");
  tr.classList.add("selected");
  renderView();
}
$("runs").addEventListener("click", selectRunFromEvent);
$("runs").addEventListener("keydown", (e) => {
  if (e.key === "Enter") selectRunFromEvent(e);
});

let fixtureFilter: string | null = null; // null = all, "" = live (no fixture)
function renderFixtureFilter(): void {
  const sel = $<HTMLSelectElement>("fx-filter");
  const ids = [...new Set(runs.map((r) => r.fixtureId ?? ""))].sort();
  sel.replaceChildren(new Option("all", "*"), ...ids.map((id) => new Option(id || "live mic", id)));
  sel.value = fixtureFilter === null ? "*" : fixtureFilter;
  if (sel.value !== (fixtureFilter ?? "*")) fixtureFilter = null;
}
$("fx-filter").addEventListener("change", (e) => {
  const v = (e.target as HTMLSelectElement).value;
  fixtureFilter = v === "*" ? null : v;
  renderResults();
});
$("group-by").addEventListener("change", (e) => {
  settings.groupBy = (e.target as HTMLSelectElement).value as GroupBy;
  saveSettings();
  renderResults();
});

const METRIC_LABEL: Record<TableMetric, string> = {
  ttfa: "TTFA", tta: "TTA", stt: "STT final", llmFirst: "LLM first token", toolCall: "Tool call", opusFirst: "Opus first token",
  opusSpoken: "Opus spoken line", opusTotal: "Opus total", ttsFirst: "Answer TTS first byte", costUsd: "Cost / turn",
};

function renderResults(): void {
  const table = $("stats");
  const groups = summaryTable(runs, settings.groupBy, fixtureFilter);
  if (!groups.length) {
    const tb = document.createElement("tbody");
    const tr = tb.insertRow();
    const td = tr.insertCell();
    td.className = "muted";
    td.textContent = "No runs yet.";
    table.replaceChildren(tb);
    return;
  }
  const thead = document.createElement("thead");
  const h1 = thead.insertRow();
  const h2 = thead.insertRow();
  const corner = document.createElement("th");
  corner.rowSpan = 2;
  corner.textContent = "Metric";
  h1.append(corner);
  for (const g of groups) {
    const th = document.createElement("th");
    th.colSpan = 3;
    th.className = "group";
    th.textContent = `${APPROACH_LABEL[g.key] ?? g.key}`;
    const n = document.createElement("span");
    n.className = "muted small";
    n.textContent = ` n=${g.n}`;
    th.append(n);
    h1.append(th);
    for (const s of ["p50", "p90", "mean"]) {
      const sub = document.createElement("th");
      sub.className = s === "p50" ? "num first" : "num";
      sub.textContent = s;
      h2.append(sub);
    }
  }
  const tbody = document.createElement("tbody");
  for (const m of TABLE_METRICS) {
    const tr = tbody.insertRow();
    const th = document.createElement("th");
    th.textContent = METRIC_LABEL[m];
    tr.append(th);
    const p50s = groups.map((g) => g.stats[m].p50).filter((v): v is number => v !== null);
    const best = groups.length > 1 && p50s.length > 1 ? Math.min(...p50s) : null;
    for (const g of groups) {
      const s = g.stats[m];
      for (const k of ["p50", "p90", "mean"] as const) {
        const td = tr.insertCell();
        td.className = k === "p50" ? "num first" : "num";
        td.textContent = fmtMetric(m, s[k]);
        if (k === "p50" && best !== null && s.p50 === best) td.classList.add("best");
        if (k === "mean" && s.n && s.n < g.n) {
          const n = document.createElement("sup");
          n.className = "muted";
          n.textContent = ` n${s.n}`;
          td.append(n);
        }
        td.title = `${METRIC_LABEL[m]} · ${g.key} · ${k} · n=${s.n}`;
      }
    }
  }
  table.replaceChildren(thead, tbody);
}

// ── export / past runs ──────────────────────────────
function download(name: string, data: string, type: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
$("export-json").addEventListener("click", () => download(`latency-runs-${stamp()}.json`, JSON.stringify(runs, null, 1), "application/json"));
$("export-csv").addEventListener("click", () => download(`latency-runs-${stamp()}.csv`, toCsv(runs), "text/csv"));
$("clear-runs").addEventListener("click", () => {
  if (runs.length && !confirm(`Clear ${runs.length} runs from this page? (results/*.jsonl on the server is untouched)`)) return;
  runs = [];
  selectedRunId = null;
  renderRuns();
  renderResults();
  renderView();
});
$("load-past").addEventListener("click", async () => {
  const b = $<HTMLButtonElement>("load-past");
  b.disabled = true;
  try {
    const res = await fetch("/api/results");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const past = ((await res.json()) as RunRecord[]).filter((r) => r && typeof r.runId === "string" && r.config).map(normalizeRun);
    const known = new Set(runs.map((r) => r.runId));
    const fresh = past.filter((r) => !known.has(r.runId));
    runs = [...fresh, ...runs];
    setStatus(`loaded ${fresh.length} past run(s)`);
    renderRuns();
    renderResults();
    renderView();
  } catch (e) {
    setStatus(`load past runs: ${(e as Error).message}`);
  } finally {
    b.disabled = false;
  }
});

// ── init ────────────────────────────────────────────
renderVendorLegend($("wf-legend"));
syncControls();
renderFixtures();
renderRuns();
renderResults();
renderView();
updateButtons();
new ResizeObserver(() => scheduleRender()).observe($("waterfall"));
