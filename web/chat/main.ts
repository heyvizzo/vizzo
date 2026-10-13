// Chat: a multi-turn voice conversation with the real vendors, switching approach A/B/C per turn,
// while pointing at the demo page. Uses chat mode (RunConfig.memory): the server keeps the
// conversation per connection and shares it across approaches.
import "../cursor/cursor.css";
import "./chat.css";
import { connectWithStatus } from "../common.ts";
import { DEFAULT_CONFIG, type Approach, type RealtimeModel, type RouterMode, type RunConfig, type TtsModel } from "../../shared/config.ts";
import type { PointingTarget, RunRecord, Segment, ServerMsg } from "../../shared/protocol.ts";
import { startCapture, type CaptureHandle } from "../audio/capture.ts";
import { warmUpAudio } from "../audio/context.ts";
import { createPlayer, type Player } from "../audio/player.ts";
import { bindPushToTalk } from "../audio/ptt.ts";
import { mountDemo } from "../cursor/demoLoader.ts";
import { renderOverlay } from "../cursor/overlay.ts";
import { Sampler } from "../cursor/sampler.ts";

const PRE_ROLL_MS = 500;
const BATCH_MS = 100;
/** Give up on a turn that never gets turn.done (server hiccup). */
const TURN_TIMEOUT_MS = 90_000;
const SHOWN_ALGORITHM = "dwellMode";
const STORE_KEY = "chat.settings.v1";

type ChatApproach = Exclude<Approach, "cursor-only">;
const APPROACHES: { id: ChatApproach; label: string; note: string }[] = [
  { id: "realtime", label: "A · Realtime", note: "OpenAI Realtime hears your audio and talks back; hard questions go to Opus. It can't see what you point at." },
  { id: "pipeline", label: "B · Pipeline", note: "Scribe → Haiku → ElevenLabs; hard questions go to Opus. Pointing is resolved from word timestamps." },
  { id: "hybrid", label: "C · Hybrid", note: "OpenAI Realtime for voice, plus Scribe in parallel so it knows what you pointed at." },
];

interface Settings { approach: ChatApproach; realtimeModel: RealtimeModel; routerMode: RouterMode; ttsModel: TtsModel }
const settings: Settings = { approach: "pipeline", realtimeModel: DEFAULT_CONFIG.realtimeModel, routerMode: "auto", ttsModel: DEFAULT_CONFIG.ttsModel };
try { Object.assign(settings, JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}")); } catch { /* storage unavailable */ }
const saveSettings = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* ignore */ } };

// ── layout ─────────────────────────────────────────
const app = document.getElementById("app")!;
app.classList.add("chat");
app.innerHTML = `
<div class="cl-demo" id="demo-scroller">
  <div id="demo-root"></div>
  <div id="ov-layer" aria-hidden="true"></div>
</div>
<aside class="chat-side">
  <section class="panel chat-head">
    <div class="seg" id="approaches" role="group" aria-label="Approach"></div>
    <p class="approach-note" id="approach-note"></p>
    <div class="opts">
      <label data-for="realtime hybrid">Realtime <select id="rt-model">
        <option value="gpt-realtime-2.1">gpt-realtime-2.1</option><option value="gpt-realtime-2.1-mini">gpt-realtime-2.1-mini</option>
      </select></label>
      <label data-for="pipeline">Router <select id="router">
        <option value="auto">auto (Haiku may answer)</option><option value="forced">forced (always Opus)</option>
      </select></label>
      <label data-for="pipeline">Voice <select id="tts">
        <option value="eleven_v4_turbo">v4 Turbo</option><option value="eleven_flash_v2_5">Flash v2.5</option>
      </select></label>
      <span class="spacer"></span>
      <button id="reset" title="Forget the conversation on the server">New conversation</button>
    </div>
  </section>
  <section class="panel messages" id="messages" aria-live="polite">
    <p class="empty" id="empty">Hold <b>Space</b> (or the button) and talk. Point at things on the page while you say “this” or “that”. You can switch approach between turns; the conversation carries over.</p>
  </section>
  <section class="panel talk">
    <div class="row">
      <button id="enable">Enable mic &amp; audio</button>
      <button id="ptt" class="ptt-big" disabled>Hold to talk</button>
    </div>
    <p class="status" id="status"></p>
  </section>
</aside>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const scroller = $("demo-scroller");
const demoRoot = $("demo-root");
const layer = $("ov-layer");
const messages = $("messages");

function setStatus(text: string, isErr = false): void {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("err", isErr);
}

// ── settings UI ────────────────────────────────────
const segButtons = new Map<ChatApproach, HTMLButtonElement>();
for (const a of APPROACHES) {
  const b = document.createElement("button");
  b.textContent = a.label;
  b.onclick = () => { settings.approach = a.id; saveSettings(); renderSettings(); };
  segButtons.set(a.id, b);
  $("approaches").append(b);
}
const rtModel = $<HTMLSelectElement>("rt-model");
const router = $<HTMLSelectElement>("router");
const tts = $<HTMLSelectElement>("tts");
rtModel.onchange = () => { settings.realtimeModel = rtModel.value as RealtimeModel; saveSettings(); };
router.onchange = () => { settings.routerMode = router.value as RouterMode; saveSettings(); };
tts.onchange = () => { settings.ttsModel = tts.value as TtsModel; saveSettings(); };

function renderSettings(): void {
  for (const [id, b] of segButtons) b.setAttribute("aria-pressed", String(id === settings.approach));
  $("approach-note").textContent = APPROACHES.find((a) => a.id === settings.approach)!.note;
  rtModel.value = settings.realtimeModel;
  router.value = settings.routerMode;
  tts.value = settings.ttsModel;
  for (const el of document.querySelectorAll<HTMLElement>(".opts [data-for]")) {
    el.hidden = !el.dataset.for!.split(" ").includes(settings.approach);
  }
}
renderSettings();

function config(): RunConfig {
  return {
    ...DEFAULT_CONFIG,
    approach: settings.approach,
    realtimeModel: settings.realtimeModel,
    routerMode: settings.routerMode,
    ttsModel: settings.ttsModel,
    prewarm: true,
    memory: true,
  };
}

// ── conversation view ──────────────────────────────
interface TurnView {
  root: HTMLElement;
  user: HTMLElement;
  chips: HTMLElement;
  bot: HTMLElement;
  botText: Text;
  detail: HTMLDetailsElement;
  detailPre: HTMLElement;
  meta: HTMLElement;
}

function addTurnView(approach: ChatApproach): TurnView {
  $("empty").hidden = true;
  const root = document.createElement("div");
  root.className = "turn";
  const user = document.createElement("div");
  user.className = "bubble user pending";
  user.textContent = "listening…";
  const chips = document.createElement("div");
  chips.className = "chips";
  const bot = document.createElement("div");
  bot.className = "bubble bot";
  bot.hidden = true;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = APPROACHES.find((a) => a.id === approach)!.label;
  const botText = document.createTextNode("");
  bot.append(who, botText);
  const detail = document.createElement("details");
  detail.className = "detail";
  detail.hidden = true;
  const summary = document.createElement("summary");
  summary.textContent = "Opus's detailed answer";
  const detailPre = document.createElement("pre");
  detail.append(summary, detailPre);
  const meta = document.createElement("div");
  meta.className = "meta";
  root.append(user, chips, bot, detail, meta);
  messages.append(root);
  scrollDown();
  return { root, user, chips, bot, botText, detail, detailPre, meta };
}

function scrollDown(): void {
  messages.scrollTop = messages.scrollHeight;
}

/** Opus streams `SPOKEN: …` + blank line + details. The spoken part is already in the bot bubble. */
function detailOf(opusText: string): string {
  if (!/^\s*SPOKEN:/i.test(opusText)) return opusText;
  const i = opusText.search(/\n\s*\n/);
  return i < 0 ? "" : opusText.slice(i).trim();
}

function shortTarget(t: PointingTarget): string {
  const s = t.sample;
  if (!s) return "(nothing)";
  return s.label || s.elementPath?.split(">").pop()?.trim() || "(unknown)";
}

function renderChips(v: TurnView, targets: PointingTarget[], approach: ChatApproach): void {
  v.chips.replaceChildren();
  for (const t of targets.filter((x) => x.algorithm === SHOWN_ALGORITHM)) {
    const c = document.createElement("span");
    c.className = "chip";
    const b = document.createElement("b");
    b.textContent = `“${t.word}”`;
    c.append(b, ` → ${shortTarget(t)}`);
    if (approach === "realtime") c.title = "Approach A doesn't use pointing; shown for reference";
    v.chips.append(c);
  }
  if (approach === "realtime" && v.chips.childElementCount) {
    const n = document.createElement("span");
    n.className = "chip";
    n.textContent = "not sent to A";
    v.chips.append(n);
  }
}

function fmtMs(v: number | null | undefined): string {
  return v == null ? "–" : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
}

function renderMeta(v: TurnView, run: RunRecord): void {
  v.meta.replaceChildren();
  const add = (text: string, cls?: string) => {
    const s = document.createElement("span");
    s.textContent = text;
    if (cls) s.className = cls;
    v.meta.append(s);
  };
  add(`first audio ${fmtMs(run.metrics.ttfa)}`);
  add(`answer ${fmtMs(run.metrics.tta)}`);
  if (run.metrics.opusTotal != null) add(`opus ${fmtMs(run.metrics.opusTotal)}`);
  add(`$${run.costUsd.toFixed(4)}`);
  if (run.error) add(run.error, "err");
}

// ── audio + cursor ─────────────────────────────────
const sock = connectWithStatus();
const sampler = new Sampler(demoRoot, scroller);
let player: Player | null = null;
let lastTargets: PointingTarget[] = [];

void mountDemo(demoRoot).then(() => sampler.start());
scroller.addEventListener("scroll", () => drawOverlay(), { passive: true });
window.addEventListener("resize", () => drawOverlay());

function drawOverlay(): void {
  renderOverlay(layer, scroller, lastTargets, [], new Set([SHOWN_ALGORITHM]));
}

async function enableAudio(): Promise<void> {
  try {
    await warmUpAudio();
    player ??= await createPlayer();
    player.onPlayed = (segment: Segment, tPlayed: number) => {
      if (turn && !turn.finished) sock.send({ type: "audio.played", turnId: turn.turnId, segment, tPlayed });
    };
    $("enable").hidden = true;
    $<HTMLButtonElement>("ptt").disabled = false;
    setStatus("Ready. Hold Space or the button to talk.");
  } catch (e) {
    setStatus(`Mic/audio unavailable: ${(e as Error).message}`, true);
  }
}
$("enable").onclick = () => void enableAudio();

sock.onAudio((pcm) => {
  if (turn && !turn.finished) player?.push(pcm);
});

// ── turn flow ──────────────────────────────────────
interface Turn {
  turnId: string;
  approach: ChatApproach;
  tPress: number;
  tRelease?: number;
  capture?: CaptureHandle;
  audioStarted: Promise<void>;
  sentUpTo: number;
  batchTimer?: ReturnType<typeof setInterval>;
  timeout?: ReturnType<typeof setTimeout>;
  view: TurnView;
  voice: string;
  opus: string;
  finished: boolean;
}
let turn: Turn | null = null;

function lockControls(locked: boolean): void {
  for (const b of segButtons.values()) b.disabled = locked;
  $<HTMLButtonElement>("reset").disabled = locked;
}

function flushSamples(t: Turn): void {
  const fresh = sampler.range(t.tPress - PRE_ROLL_MS).filter((s) => s.t > t.sentUpTo);
  if (!fresh.length) return;
  t.sentUpTo = fresh[fresh.length - 1]!.t;
  sock.send({ type: "cursor.samples", turnId: t.turnId, samples: fresh });
}

function press(): void {
  if (!player) return setStatus("Click “Enable mic & audio” first.", true);
  if (turn && !turn.finished) return setStatus("Still answering the last turn…");
  if (!sock.isOpen) return setStatus("Server not connected.", true);
  player.reset();
  const tPress = performance.now();
  const t: Turn = {
    turnId: crypto.randomUUID(), approach: settings.approach, tPress, audioStarted: Promise.resolve(),
    sentUpTo: tPress - PRE_ROLL_MS - 1, view: addTurnView(settings.approach), voice: "", opus: "", finished: false,
  };
  turn = t;
  lockControls(true);
  lastTargets = [];
  drawOverlay();
  sock.send({ type: "turn.start", turnId: t.turnId, config: config(), tPress });
  t.batchTimer = setInterval(() => flushSamples(t), BATCH_MS);
  $("ptt").classList.add("live");
  setStatus("Listening… release to send.");
  t.audioStarted = (async () => {
    try {
      t.capture = await startCapture({ onFrame: (pcm) => { if (turn === t && t.tRelease === undefined) sock.sendAudio(pcm); } });
      const tAudioStart = await t.capture.tAudioStart;
      sock.send({ type: "turn.audioStart", turnId: t.turnId, tAudioStart });
    } catch (e) {
      failTurn(t, `Mic: ${(e as Error).message}`);
    }
  })();
}

async function release(): Promise<void> {
  const t = turn;
  if (!t || t.finished || t.tRelease !== undefined) return;
  t.tRelease = performance.now();
  $("ptt").classList.remove("live");
  await t.audioStarted;
  t.capture?.stop();
  if (turn !== t || t.finished) return;
  flushSamples(t);
  clearInterval(t.batchTimer);
  sock.send({ type: "turn.release", turnId: t.turnId, tRelease: t.tRelease });
  setStatus("Thinking…");
  t.timeout = setTimeout(() => failTurn(t, "No reply from the server (timed out)."), TURN_TIMEOUT_MS);
}

function endTurn(t: Turn): void {
  t.finished = true;
  clearInterval(t.batchTimer);
  clearTimeout(t.timeout);
  t.capture?.stop();
  $("ptt").classList.remove("live");
  lockControls(false);
}

function failTurn(t: Turn, msg: string): void {
  if (t.finished) return;
  sock.send({ type: "turn.cancel", turnId: t.turnId });
  endTurn(t);
  if (t.view.user.classList.contains("pending")) t.view.user.textContent = "(cancelled)";
  const e = document.createElement("span");
  e.className = "err";
  e.textContent = msg;
  t.view.meta.append(e);
  setStatus(msg, true);
}

sock.on((msg: ServerMsg) => {
  const t = turn;
  if (!t || !("turnId" in msg) || msg.turnId !== t.turnId) {
    if (msg.type === "error" && !("turnId" in msg && msg.turnId)) setStatus(`${msg.source}: ${msg.message}`, true);
    return;
  }
  const v = t.view;
  switch (msg.type) {
    case "stt.partial":
      v.user.textContent = msg.text || "…";
      break;
    case "stt.final":
      v.user.classList.remove("pending");
      v.user.textContent = msg.text || "(nothing heard)";
      break;
    case "pointing.resolved":
      lastTargets = msg.targets;
      renderChips(v, msg.targets, t.approach);
      drawOverlay();
      break;
    case "voice.text":
      t.voice += msg.delta;
      v.bot.hidden = false;
      v.botText.data = t.voice;
      setStatus("Speaking…");
      break;
    case "opus.text": {
      t.opus += msg.delta;
      const d = detailOf(t.opus);
      if (d) { v.detail.hidden = false; v.detailPre.textContent = d; }
      if (!t.voice) setStatus("Opus is thinking…");
      break;
    }
    case "audio.segment":
      if (msg.state === "start") player?.startSegment(msg.segment);
      else player?.endSegment(msg.segment);
      break;
    case "error":
      setStatus(`${msg.source}: ${msg.message}`, true);
      break;
    case "turn.done": {
      const run = msg.run;
      endTurn(t);
      if (v.user.classList.contains("pending")) {
        v.user.classList.remove("pending");
        v.user.textContent = run.transcript || "(not transcribed)";
      }
      if (!t.voice && run.voiceText) { v.bot.hidden = false; v.botText.data = run.voiceText; }
      renderMeta(v, run);
      setStatus(run.error ? `Finished with an error: ${run.error}` : "Ready.", !!run.error);
      break;
    }
  }
  scrollDown();
});

bindPushToTalk({ button: $("ptt"), onPress: () => press(), onRelease: () => void release() });

$("reset").onclick = () => {
  if (turn && !turn.finished) return;
  sock.send({ type: "conversation.reset" });
  player?.reset();
  messages.querySelectorAll(".turn").forEach((n) => n.remove());
  $("empty").hidden = false;
  lastTargets = [];
  drawOverlay();
  setStatus("New conversation.");
};

// The server keeps the conversation per WebSocket connection: after a reconnect it starts fresh.
{
  const render = sock.onStatus;
  let opened = false;
  sock.onStatus = (s) => {
    render?.(s);
    if (s !== "open") return;
    if (opened && messages.querySelector(".turn")) {
      const note = document.createElement("p");
      note.className = "status err";
      note.textContent = "Reconnected: the server started a new conversation (earlier turns are forgotten).";
      messages.append(note);
      scrollDown();
    }
    opened = true;
  };
}
