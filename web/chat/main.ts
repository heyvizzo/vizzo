// Chat: a multi-turn voice conversation with the real vendors, switching approach A/B/C per turn,
// while pointing at the demo page. Uses chat mode (RunConfig.memory): the server keeps the
// conversation per connection and shares it across approaches.
// Per turn the server sends a `decision` (question / task / clarify / answer + estimate); short tasks get
// spoken fillers, long ones run as background `job`s whose results are read out later as a `notice`.
// The user can barge in (press while the assistant talks) or stop it (Esc / Stop button).
// `?demo=1` renders a static sample conversation for layout review (no mic needed).
import "../cursor/cursor.css";
import "./chat.css";
import { connectWithStatus } from "../common.ts";
import { DEFAULT_CONFIG, type Approach, type RealtimeModel, type RouterMode, type RunConfig, type SpeechLanguage, type TtsModel } from "../../shared/config.ts";
import type { CostItem, CursorRest, LlmPrompt, LlmResponse, PageEvents, JobInfo, PointingTarget, RouteIntent, RunRecord, Segment, ServerMsg, Word } from "../../shared/protocol.ts";
import { startCapture, type CaptureHandle } from "../audio/capture.ts";
import { warmUpAudio } from "../audio/context.ts";
import { createPlayer, type Player } from "../audio/player.ts";
import { bindPushToTalk } from "../audio/ptt.ts";
import { mountDemo } from "../cursor/demoLoader.ts";
import { describeElement, type ElLike } from "../cursor/dom.ts";
import { renderOverlay } from "../cursor/overlay.ts";
import { Sampler } from "../cursor/sampler.ts";
import { createPageContextRecorder } from "../cursor/pageContext.ts";
import { annotateTranscript, clickVerb, describeRef, relTime } from "../../shared/pointing.ts";
import { addResponse, renderPrompt } from "./promptView.ts";
import { fmtUsd, renderTurnCost, type TurnCost } from "./costView.ts";
import { PlaybackClock, decisionBadges, detailOf, fmtEstimate, jobHeadline, runningLabel, spokenOf, type DecisionLike } from "./logic.ts";

const PRE_ROLL_MS = 500;
const BATCH_MS = 100;
/** Give up on a turn that never gets turn.done (server hiccup). */
const TURN_TIMEOUT_MS = 90_000;
const TICK_MS = 250;
const SHOWN_ALGORITHM = "dwellMode";
const STORE_KEY = "chat.settings.v1";
const LONG_TASK_CHOICES = [10, 20, 30, 60];
const LANGUAGES: { id: SpeechLanguage; label: string }[] = [
  { id: "auto", label: "Auto (en/ro)" }, { id: "en", label: "English" }, { id: "ro", label: "Română" },
];
/** Dev-only static sample conversation (see renderDemo). */
const DEMO = import.meta.env.DEV && new URLSearchParams(location.search).has("demo");

type ChatApproach = Exclude<Approach, "cursor-only">;
const APPROACHES: { id: ChatApproach; label: string; note: string }[] = [
  { id: "realtime", label: "A · Realtime", note: "OpenAI Realtime hears your audio and talks back; hard questions go to Opus. It can't see what you point at." },
  { id: "pipeline", label: "B · Pipeline", note: "Scribe → Haiku → ElevenLabs; hard questions go to Opus. Pointing is resolved from word timestamps." },
  { id: "hybrid", label: "C · Hybrid", note: "OpenAI Realtime for voice, plus Scribe in parallel so it knows what you pointed at." },
];
const labelOf = (a: Approach): string => APPROACHES.find((x) => x.id === a)?.label ?? a;

interface Settings {
  approach: ChatApproach; realtimeModel: RealtimeModel; routerMode: RouterMode; ttsModel: TtsModel; longTaskSeconds: number; language: SpeechLanguage;
}
const settings: Settings = {
  approach: "pipeline", realtimeModel: DEFAULT_CONFIG.realtimeModel, routerMode: "auto", ttsModel: DEFAULT_CONFIG.ttsModel, longTaskSeconds: 20,
  language: "auto",
};
try { Object.assign(settings, JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}")); } catch { /* storage unavailable */ }
if (!LONG_TASK_CHOICES.includes(settings.longTaskSeconds)) settings.longTaskSeconds = 20;
if (!LANGUAGES.some((l) => l.id === settings.language)) settings.language = "auto";
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
      <label title="Spoken language: Scribe transcription and the pointing words (“this”, “ăsta”…). Auto detects English or Romanian.">Language <select id="language">
        ${LANGUAGES.map((l) => `<option value="${l.id}">${l.label}</option>`).join("")}
      </select></label>
    </div>
    <div class="head-row opts">
      <label title="Tasks estimated longer than this run in the background; the result is read out when done">Background after <select id="long-task">
        ${LONG_TASK_CHOICES.map((s) => `<option value="${s}">${s} s</option>`).join("")}
      </select></label>
      <span class="jobs-pill" id="jobs-pill" hidden></span>
      <span class="spacer"></span>
      <button id="reset" title="Forget the conversation on the server (also drops background tasks)">New conversation</button>
    </div>
  </section>
  <section class="panel messages" id="messages" aria-live="polite">
    <p class="empty" id="empty">Hold <b>Space</b> (or the button) and talk. Point at things on the page while you say “this” or “that”. Press again while it's talking to interrupt; <b>Esc</b> stops it. You can switch approach between turns; the conversation carries over.</p>
  </section>
  <section class="panel talk">
    <div class="row">
      <button id="enable">Enable mic &amp; audio</button>
      <button id="ptt" class="ptt-big" disabled>Hold to talk</button>
      <button id="stop" class="stop" hidden title="Stop speaking (Esc)">Stop</button>
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
// Never locked: a change applies from the next turn (barge-in means a turn can start at any time).
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
const longTask = $<HTMLSelectElement>("long-task");
const language = $<HTMLSelectElement>("language");
rtModel.onchange = () => { settings.realtimeModel = rtModel.value as RealtimeModel; saveSettings(); };
router.onchange = () => { settings.routerMode = router.value as RouterMode; saveSettings(); };
tts.onchange = () => { settings.ttsModel = tts.value as TtsModel; saveSettings(); };
longTask.onchange = () => { settings.longTaskSeconds = Number(longTask.value); saveSettings(); };
language.onchange = () => { settings.language = language.value as SpeechLanguage; saveSettings(); };

function renderSettings(): void {
  for (const [id, b] of segButtons) b.setAttribute("aria-pressed", String(id === settings.approach));
  $("approach-note").textContent = APPROACHES.find((a) => a.id === settings.approach)!.note;
  rtModel.value = settings.realtimeModel;
  router.value = settings.routerMode;
  tts.value = settings.ttsModel;
  longTask.value = String(settings.longTaskSeconds);
  language.value = settings.language;
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
    fillers: true,
    backgroundLongTasks: true,
    longTaskSeconds: settings.longTaskSeconds,
    language: settings.language,
  };
}

// ── conversation view ──────────────────────────────
interface TurnView {
  root: HTMLElement;
  user: HTMLElement;
  /** The transcript with its reference markers ("move it [@1] over there [1]"), under the user's bubble. */
  annot: HTMLElement;
  chips: HTMLElement;
  badges: HTMLElement;
  decision: HTMLElement;
  bot: HTMLElement;
  botText: Text;
  detail: HTMLDetailsElement;
  detailPre: HTMLElement;
  meta: HTMLElement;
  /** Cost breakdown (filled on turn.done; background task costs added as they arrive). */
  costBox?: HTMLElement;
  cost?: TurnCost;
  /** "Prompt" section, created on the first llm.prompt for the turn. */
  prompts?: { root: HTMLDetailsElement; summary: HTMLElement; list: HTMLElement; n: number };
  /** stt.final words and the pointing references, for the annotated transcript. */
  words?: Word[];
  targets?: PointingTarget[];
  rests?: CursorRest[];
}
/** Every turn view by turnId (job cards are placed after the turn that started them). */
const views = new Map<string, TurnView>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function addTurnView(turnId: string, approach: ChatApproach): TurnView {
  $("empty").hidden = true;
  const root = el("div", "turn");
  root.dataset.turn = turnId;
  const user = el("div", "bubble user pending", "listening…");
  const annot = el("div", "annot");
  annot.hidden = true;
  const chips = el("div", "chips");
  const badges = el("div", "badges");
  badges.hidden = true;
  const decision = el("span", "decision");
  badges.append(decision);
  const bot = el("div", "bubble bot");
  bot.hidden = true;
  const botText = document.createTextNode("");
  bot.append(el("span", "who", labelOf(approach)), botText);
  const detail = el("details", "detail");
  detail.hidden = true;
  const detailPre = el("pre");
  detail.append(el("summary", undefined, "Opus's detailed answer"), detailPre);
  const meta = el("div", "meta");
  root.append(user, annot, chips, badges, bot, detail, meta);
  messages.append(root);
  const v: TurnView = { root, user, annot, chips, badges, decision, bot, botText, detail, detailPre, meta };
  views.set(turnId, v);
  scrollDown();
  return v;
}

function scrollDown(): void {
  messages.scrollTop = messages.scrollHeight;
}

function renderDecision(v: TurnView, d: DecisionLike): void {
  v.decision.replaceChildren();
  decisionBadges(d).forEach((text, i) => {
    const cls = i === 0 ? `badge intent-${d.intent}` : text === "working in background" ? "badge bg" : "badge";
    v.decision.append(el("span", cls, text));
  });
  v.badges.hidden = false;
}

/** Small state tag on a turn ("interrupted", "stopped"), once. */
function addTag(v: TurnView, text: string): void {
  if (v.badges.querySelector(".tag")) return;
  v.badges.append(el("span", "tag", text));
  v.badges.hidden = false;
}

function shortTarget(t: PointingTarget): string {
  const s = t.sample;
  if (!s) return "(nothing)";
  return s.label || s.elementPath?.split(">").pop()?.trim() || "(unknown)";
}

/** The final transcript in the user's bubble, with the detected language as a small tag. */
function renderUserText(v: TurnView, text: string, words: Word[], lang?: string): void {
  v.user.classList.remove("pending");
  v.user.textContent = text || "(nothing heard)";
  if (lang) {
    const tag = el("span", "lang", lang);
    tag.title = `Language detected by Scribe: ${lang}`;
    v.user.append(tag);
  }
  v.words = words;
  renderAnnot(v);
}

/** "move it [@1] over there [1]": what references the model got, once there are words and any markers. */
function renderAnnot(v: TurnView): void {
  const text = v.words ? annotateTranscript(v.words, (v.targets ?? []).filter((t) => t.algorithm === SHOWN_ALGORITHM), v.rests ?? []) : null;
  v.annot.textContent = text ?? "";
  v.annot.title = text ? "The transcript with the references the model got: [n] pointing words, [@n] cursor rests" : "";
  v.annot.hidden = !text;
}

/** Seconds from the turn's first audio sample: "1.2–1.9 s". */
function restSpan(r: CursorRest, tAudioStart: number | undefined): string {
  const a = relTime(r.tStart, tAudioStart), b = relTime(r.tEnd, tAudioStart);
  return a && b ? `${a.replace(" s", "")}–${b}` : `${Math.round(r.tEnd - r.tStart)} ms`;
}

function renderChips(v: TurnView, targets: PointingTarget[], approach: ChatApproach, rests: CursorRest[] = [], tAudioStart?: number): void {
  v.chips.replaceChildren();
  v.targets = targets;
  v.rests = rests;
  for (const t of targets.filter((x) => x.algorithm === SHOWN_ALGORITHM)) {
    const c = el("span", "chip");
    c.append(el("b", undefined, `${t.ref !== undefined ? `[${t.ref}] ` : ""}“${t.word}”`), ` → ${shortTarget(t)}`);
    if (approach === "realtime") c.title = "Approach A doesn't use pointing; shown for reference";
    v.chips.append(c);
  }
  for (const r of rests) {
    const c = el("span", "chip rest");
    c.append(el("b", undefined, `[@${r.ref}]`), ` rested on ${r.sample.label || r.sample.elementPath?.split(">").pop()?.trim() || "(element)"}`);
    c.title = `${describeRef(r.sample) || "(element)"} · ${restSpan(r, tAudioStart)}${r.whole ? " · whole time" : ""}`;
    if (r.whole) c.append(el("span", "whole", " · whole time"));
    v.chips.append(c);
  }
  if (approach === "realtime" && v.chips.childElementCount) v.chips.append(el("span", "chip", "not sent to A"));
  renderAnnot(v);
}

/** What was clicked / highlighted during the turn (with times from when you started speaking), under the pointing chips. */
function renderPageChips(v: TurnView, page: PageEvents, tAudioStart: number | undefined): void {
  if (!page.clicks.length && !page.preselected && !page.highlights.length) return;
  const row = el("div", "chips");
  const at = (t: number) => { const r = relTime(t, tAudioStart); return r ? ` · ${r}` : ""; };
  const short = (text: string) => (text.length > 50 ? `${text.slice(0, 50)}…` : text);
  for (const c of page.clicks) {
    const chip = el("span", "chip");
    chip.append(el("b", undefined, clickVerb(c).toLowerCase()), ` ${c.label ?? "(element)"}${c.container ? ` · ${c.container}` : ""}${at(c.t)}`);
    chip.title = `click times: ${c.times.map((t) => relTime(t, tAudioStart) ?? "?").join(", ")}`;
    row.append(chip);
  }
  if (page.preselected) {
    const chip = el("span", "chip");
    chip.append(el("b", undefined, "already highlighted"), ` “${short(page.preselected.text)}”`);
    row.append(chip);
  }
  page.highlights.forEach((h, i) => {
    const chip = el("span", "chip");
    chip.append(el("b", undefined, `highlight ${i + 1}`), ` “${short(h.text)}”${at(h.t)}`);
    row.append(chip);
  });
  v.chips.after(row);
}

function fmtMs(v: number | null | undefined): string {
  return v == null ? "–" : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
}

function renderMeta(v: TurnView, run: Pick<RunRecord, "metrics" | "costUsd" | "error">): void {
  v.meta.replaceChildren();
  const add = (text: string, cls?: string) => v.meta.append(el("span", cls, text));
  add(`first audio ${fmtMs(run.metrics.ttfa)}`);
  add(`answer ${fmtMs(run.metrics.tta)}`);
  if (run.metrics.opusTotal != null) add(`opus ${fmtMs(run.metrics.opusTotal)}`);
  if (run.error) add(run.error, "err");
}

/** Show the turn's itemized cost (plus any background task it started). */
function renderCost(v: TurnView, run: Pick<RunRecord, "costUsd" | "costItems">, turnId: string): void {
  const jobCosts = [...jobs.values()].filter((c) => c.info.turnId === turnId).map(jobCost);
  v.cost = { items: run.costItems ?? [{ label: "total", usd: run.costUsd }], total: run.costUsd, jobs: jobCosts };
  if (!v.costBox) { v.costBox = el("div", "costbox"); v.meta.after(v.costBox); }
  renderTurnCost(v.costBox, v.cost);
}

const jobCost = (c: { info: JobInfo }): TurnCost["jobs"][number] => ({
  label: "background task", items: c.info.costItems ?? [], total: c.info.costUsd ?? 0, running: c.info.state === "running",
});

/** A job's cost changed: refresh the cost of the turn that started it. */
function refreshTurnCost(turnId: string): void {
  const v = views.get(turnId);
  if (!v?.cost || !v.costBox) return;
  v.cost.jobs = [...jobs.values()].filter((c) => c.info.turnId === turnId).map(jobCost);
  renderTurnCost(v.costBox, v.cost);
}

// ── background job cards ───────────────────────────
interface JobCard {
  info: JobInfo;
  /** performance.now() when the job started (approx: first seen minus elapsedMs). */
  tStart: number;
  root: HTMLElement;
  head: HTMLElement;
  question: HTMLElement;
  sub: HTMLElement;
  spoken: HTMLElement;
  detail: HTMLDetailsElement;
  detailPre: HTMLElement;
  err: HTMLElement;
  prompts?: NonNullable<TurnView["prompts"]>;
}
const jobs = new Map<string, JobCard>();
/** Jobs dropped by "New conversation": ignore late updates for them. */
const droppedJobs = new Set<string>();

/** Prompts of background jobs whose card doesn't exist yet. */
const pendingJobPrompts = new Map<string, { prompt: LlmPrompt; callId: string }[]>();

/** The "Prompt" section of a turn or job card: what each model call was sent. */
function promptSection(host: HTMLElement): NonNullable<TurnView["prompts"]> {
  const root = el("details", "prompts");
  const summary = el("summary");
  const list = el("div", "pcalls");
  root.append(summary, list);
  host.append(root);
  return { root, summary, list, n: 0 };
}

/** Rendered calls by callId, so responses land under their prompt. */
const calls = new Map<string, HTMLDetailsElement>();
/** Responses that arrived before their prompt was rendered (job cards not created yet). */
const pendingResponses = new Map<string, LlmResponse[]>();

function pushPrompt(sec: NonNullable<TurnView["prompts"]>, p: LlmPrompt, callId?: string): void {
  const call = renderPrompt(p);
  sec.list.append(call);
  if (callId) {
    calls.set(callId, call);
    for (const r of pendingResponses.get(callId) ?? []) addResponse(call, r);
    pendingResponses.delete(callId);
  }
  sec.n++;
  sec.summary.textContent = `Prompts & responses · ${sec.n} model call${sec.n === 1 ? "" : "s"}`;
}

function onResponse(msg: Extract<ServerMsg, { type: "llm.response" }>): void {
  const call = calls.get(msg.callId);
  if (call) addResponse(call, msg.response);
  else pendingResponses.set(msg.callId, [...(pendingResponses.get(msg.callId) ?? []), msg.response]);
}

function addPrompt(msg: Extract<ServerMsg, { type: "llm.prompt" }>): void {
  if (msg.jobId) {
    const card = jobs.get(msg.jobId);
    if (!card) { pendingJobPrompts.set(msg.jobId, [...(pendingJobPrompts.get(msg.jobId) ?? []), { prompt: msg.prompt, callId: msg.callId }]); return; }
    card.prompts ??= promptSection(card.root);
    pushPrompt(card.prompts, msg.prompt, msg.callId);
    return;
  }
  const v = views.get(msg.turnId);
  if (!v) return;
  v.prompts ??= promptSection(v.root);
  pushPrompt(v.prompts, msg.prompt, msg.callId);
}

function createJobCard(info: JobInfo): JobCard {
  $("empty").hidden = true;
  const root = el("div", "job");
  root.dataset.turn = info.turnId;
  const head = el("div", "job-head");
  const question = el("div", "job-q");
  const sub = el("div", "job-sub");
  const spoken = el("div", "job-spoken");
  const detail = el("details", "detail");
  const detailPre = el("pre");
  detail.append(el("summary", undefined, "Detailed answer"), detailPre);
  const err = el("div", "job-err");
  root.append(head, question, sub, spoken, detail, err);
  // After the starting turn (and after any earlier cards of that turn); else at the end.
  let anchor: Element | null = views.get(info.turnId)?.root ?? null;
  while (anchor?.nextElementSibling instanceof HTMLElement && anchor.nextElementSibling.matches(`.job[data-turn="${CSS.escape(info.turnId)}"]`)) {
    anchor = anchor.nextElementSibling;
  }
  if (anchor) anchor.after(root);
  else messages.append(root);
  return { info, tStart: performance.now() - (info.elapsedMs ?? 0), root, head, question, sub, spoken, detail, detailPre, err };
}

function upsertJob(info: JobInfo): void {
  if (droppedJobs.has(info.jobId)) return;
  let c = jobs.get(info.jobId);
  if (!c) {
    c = createJobCard(info);
    jobs.set(info.jobId, c);
    for (const p of pendingJobPrompts.get(info.jobId) ?? []) { c.prompts ??= promptSection(c.root); pushPrompt(c.prompts, p.prompt, p.callId); }
    pendingJobPrompts.delete(info.jobId);
    if (c.root === messages.lastElementChild) scrollDown();
  }
  if (info.state === "running" && info.elapsedMs != null) c.tStart = performance.now() - info.elapsedMs;
  // Keep text we already have if a later update omits it.
  c.info = { ...c.info, ...info };
  renderJob(c);
  renderJobsPill();
  refreshTurnCost(info.turnId);
}

function renderJob(c: JobCard): void {
  const j = c.info;
  c.root.dataset.state = j.state;
  c.head.textContent = jobHeadline(j, performance.now() - c.tStart);
  c.question.textContent = j.question ? `“${j.question}”` : "";
  c.question.hidden = !j.question;
  const est = fmtEstimate(j.estimateS);
  c.sub.textContent = [labelOf(j.approach), j.state === "running" && est ? `estimate ${est}` : ""].filter(Boolean).join(" · ");
  const spoken = j.state === "done" && j.spoken ? spokenOf(j.spoken) : "";
  c.spoken.textContent = spoken;
  c.spoken.hidden = !spoken;
  const detail = j.state === "done" && j.detail ? detailOf(j.detail) : "";
  c.detailPre.textContent = detail;
  c.detail.hidden = !detail;
  c.sub.textContent += j.costUsd !== undefined ? ` · cost ${fmtUsd(j.costUsd)}${j.costItems?.length ? ` (${j.costItems.map((i) => `${i.label.replace(/ \(.*\)$/, "")} ${fmtUsd(i.usd)}`).join(", ")})` : ""}` : "";
  c.err.textContent = j.state === "failed" ? j.error || "The task failed." : "";
  c.err.hidden = j.state !== "failed";
}

function renderJobsPill(): void {
  const n = [...jobs.values()].filter((c) => c.info.state === "running").length;
  const pill = $("jobs-pill");
  pill.textContent = runningLabel(n);
  pill.hidden = n === 0;
}

// ── audio + cursor ─────────────────────────────────
const sock = connectWithStatus();
const sampler = new Sampler(demoRoot, scroller);
/** Clicks and highlighted text on the demo page during a turn (sent as turn.context before release). */
const pageRec = createPageContextRecorder(demoRoot);
let player: Player | null = null;
let lastTargets: PointingTarget[] = [];
let lastRests: CursorRest[] = [];
/** Rough "is something audible" estimate from bytes pushed vs time. */
const playback = new PlaybackClock();
/** Whose audio was pushed last, so a barge-in only tags a turn whose reply was actually cut off. */
let audioOwner: "turn" | "notice" | null = null;
/** Job whose result is being read out (between notice start/end), if any. */
let noticeJobId: string | null = null;
/** Notices the user stopped or talked over: ignore the rest of their frames/messages. */
const stoppedNotices = new Set<string>();

/** ?demo=1: draws the sample turn's pointing targets and rests once the demo page is mounted. */
let demoOverlay: (() => void) | null = null;
void mountDemo(demoRoot).then(() => { sampler.start(); demoOverlay?.(); });
scroller.addEventListener("scroll", () => drawOverlay(), { passive: true });
window.addEventListener("resize", () => drawOverlay());

function drawOverlay(): void {
  renderOverlay(layer, scroller, lastTargets, [], new Set([SHOWN_ALGORITHM]), null, lastRests);
}

async function enableAudio(): Promise<void> {
  try {
    await warmUpAudio();
    player ??= await createPlayer();
    player.onPlayed = (segment: Segment, tPlayed: number) => {
      // Marks only for the current turn's segments; notices aren't part of any turn.
      if (segment !== "notice" && turn && !turn.finished) sock.send({ type: "audio.played", turnId: turn.turnId, segment, tPlayed });
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
  // Frames aren't tagged: they belong to the active turn once it has opened a segment (so stray frames from a
  // cancelled turn don't play over the new recording), or to the notice being read out.
  const forTurn = !!turn && !turn.finished && turn.segmentOpen;
  if (!forTurn && !noticeJobId) return;
  player?.push(pcm);
  playback.push(pcm.byteLength, performance.now());
  audioOwner = forTurn ? "turn" : "notice";
});

function onNotice(msg: Extract<ServerMsg, { type: "notice" }>): void {
  if (stoppedNotices.has(msg.jobId)) return;
  if (msg.state === "start") {
    noticeJobId = msg.jobId;
    player?.startSegment("notice");
    setStatus("Reading out a background result… (press to talk over it, Esc to stop)");
  } else if (noticeJobId === msg.jobId) {
    player?.endSegment("notice");
    noticeJobId = null;
    if (!turnBusy()) setStatus("Ready.");
  }
  refreshBusy();
}

/** Stop the notice being read out (if any) and tell the server. */
function stopNotice(): void {
  if (!noticeJobId) return;
  stoppedNotices.add(noticeJobId);
  noticeJobId = null;
  sock.send({ type: "speech.stop" });
}

// ── turn flow ──────────────────────────────────────
interface Turn {
  /** Client time of the first captured audio sample (page-event times are shown relative to it). */
  tAudioStart?: number;
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
  /** Got an audio.segment start: binary frames are now this turn's. */
  segmentOpen: boolean;
  finished: boolean;
  /** Its clicks / highlights were sent and the page reset (the recorder belongs to the next turn now). */
  pageDone?: boolean;
}
let turn: Turn | null = null;
/** Turns we cancelled: their late messages are ignored (a late turn.done still renders metrics). */
const cancelled = new Set<string>();

/** Released and waiting for / playing the reply. */
function turnBusy(): boolean {
  return !!turn && !turn.finished && turn.tRelease !== undefined;
}

/** Show the Stop button while the assistant is thinking/speaking or a notice is audible. */
function refreshBusy(): void {
  $("stop").hidden = !(DEMO || turnBusy() || noticeJobId || playback.isPlaying(performance.now()));
}

function flushSamples(t: Turn): void {
  const fresh = sampler.range(t.tPress - PRE_ROLL_MS).filter((s) => s.t > t.sentUpTo);
  if (!fresh.length) return;
  t.sentUpTo = fresh[fresh.length - 1]!.t;
  sock.send({ type: "cursor.samples", turnId: t.turnId, samples: fresh });
}

/** Cancel an unfinished turn now (don't wait for turn.done) and tag its view; keeps what was said so far. */
function cancelTurn(t: Turn, reason: "interrupt" | "stop"): void {
  if (t.finished) return;
  sock.send({ type: "turn.cancel", turnId: t.turnId, reason });
  cancelled.add(t.turnId);
  endTurn(t);
  const v = t.view;
  if (v.user.classList.contains("pending")) {
    v.user.classList.remove("pending");
    if (t.tRelease === undefined || v.user.textContent === "listening…") v.user.textContent = "(cancelled)";
  }
  addTag(v, reason === "interrupt" ? "interrupted" : "stopped");
}

function press(): void {
  if (!player) return setStatus("Click “Enable mic & audio” first.", true);
  if (!sock.isOpen) return setStatus("Server not connected.", true);
  const now = performance.now();
  const prev = turn;
  // Barge-in: cut off whatever the assistant is doing or saying.
  if (prev && !prev.finished) {
    if (prev.tRelease === undefined) return; // still recording
    cancelTurn(prev, "interrupt");
  } else if (prev && audioOwner === "turn" && playback.isPlaying(now)) {
    addTag(prev.view, "interrupted"); // finished on the server, but its audio was still playing
  }
  stopNotice();
  player.reset();
  playback.reset();

  const turnId = crypto.randomUUID();
  const t: Turn = {
    turnId, approach: settings.approach, tPress: now, audioStarted: Promise.resolve(),
    sentUpTo: now - PRE_ROLL_MS - 1, view: addTurnView(turnId, settings.approach), voice: "", opus: "", segmentOpen: false, finished: false,
  };
  turn = t;
  lastTargets = [];
  lastRests = [];
  drawOverlay();
  sock.send({ type: "turn.start", turnId, config: config(), tPress: now });
  pageRec.start(now - PRE_ROLL_MS);
  t.batchTimer = setInterval(() => flushSamples(t), BATCH_MS);
  $("ptt").classList.add("live");
  setStatus("Listening… release to send.");
  refreshBusy();
  t.audioStarted = (async () => {
    try {
      t.capture = await startCapture({ onFrame: (pcm) => { if (turn === t && t.tRelease === undefined && !t.finished) sock.sendAudio(pcm); } });
      const tAudioStart = await t.capture.tAudioStart;
      t.tAudioStart = tAudioStart;
      if (!t.finished) sock.send({ type: "turn.audioStart", turnId, tAudioStart });
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
  const page = pageRec.stop();
  // A question's highlights are sent with it; they shouldn't linger or carry over to the next one.
  pageRec.clear();
  t.pageDone = true;
  sock.send({ type: "turn.context", turnId: t.turnId, ...page });
  renderPageChips(t.view, page, t.tAudioStart);
  sock.send({ type: "turn.release", turnId: t.turnId, tRelease: t.tRelease });
  setStatus("Thinking…");
  refreshBusy();
  t.timeout = setTimeout(() => failTurn(t, "No reply from the server (timed out)."), TURN_TIMEOUT_MS);
}

/** Esc / Stop button: silence everything and cancel the turn in progress. */
function stopAll(): void {
  const now = performance.now();
  const wasPlaying = playback.isPlaying(now);
  const turnAudible = wasPlaying && audioOwner === "turn";
  player?.reset();
  playback.reset();
  const t = turn;
  const hadNotice = !!noticeJobId;
  if (t && !t.finished) cancelTurn(t, "stop");
  else if (t && turnAudible) addTag(t.view, "stopped");
  stopNotice();
  if (t || hadNotice || wasPlaying) setStatus("Stopped.");
  refreshBusy();
}

function endTurn(t: Turn): void {
  t.finished = true;
  if (!t.pageDone) { pageRec.clear(); t.pageDone = true; } // cancelled / failed before release finished
  clearInterval(t.batchTimer);
  clearTimeout(t.timeout);
  t.capture?.stop();
  if (turn === t) $("ptt").classList.remove("live");
  refreshBusy();
}

function failTurn(t: Turn, msg: string): void {
  if (t.finished) return;
  sock.send({ type: "turn.cancel", turnId: t.turnId });
  cancelled.add(t.turnId);
  endTurn(t);
  if (t.view.user.classList.contains("pending")) t.view.user.textContent = "(cancelled)";
  t.view.meta.append(el("span", "err", msg));
  setStatus(msg, true);
}

const INTENT_STATUS: Record<RouteIntent, string> = {
  question: "Looking into your question…",
  task: "Working on it…",
  clarify: "Asking you a follow-up…",
  answer: "Answering…",
};

sock.on((msg: ServerMsg) => {
  if (msg.type === "llm.prompt") return addPrompt(msg);
  if (msg.type === "llm.response") return onResponse(msg);
  if (msg.type === "job") return upsertJob(msg.job);
  if (msg.type === "notice") return onNotice(msg);
  if (!("turnId" in msg) || !msg.turnId) {
    if (msg.type === "error") setStatus(`${msg.source}: ${msg.message}`, true);
    return;
  }
  if (cancelled.has(msg.turnId)) {
    if (msg.type === "turn.done") {
      const v = views.get(msg.turnId);
      if (v) { renderMeta(v, msg.run); renderCost(v, msg.run, msg.turnId); }
    }
    return;
  }
  const t = turn;
  if (!t || msg.turnId !== t.turnId || t.finished) return;
  const v = t.view;
  switch (msg.type) {
    case "stt.partial":
      v.user.textContent = msg.text || "…";
      break;
    case "stt.final":
      renderUserText(v, msg.text, msg.words, msg.language);
      break;
    case "pointing.resolved":
      lastTargets = msg.targets;
      lastRests = msg.rests ?? [];
      renderChips(v, msg.targets, t.approach, lastRests, t.tAudioStart);
      drawOverlay();
      break;
    case "decision":
      renderDecision(v, msg);
      setStatus(msg.background ? "Working on it in the background; you can keep talking." : INTENT_STATUS[msg.intent]);
      break;
    case "voice.text":
      // Ack, fillers and the answer all arrive here; the bubble shows everything said, in order.
      t.voice += msg.delta;
      v.bot.hidden = false;
      v.botText.data = t.voice;
      setStatus("Speaking… (press to interrupt, Esc to stop)");
      break;
    case "opus.text": {
      t.opus += msg.delta;
      const d = detailOf(t.opus);
      if (d) { v.detail.hidden = false; v.detailPre.textContent = d; }
      if (!t.voice) setStatus("Opus is thinking…");
      break;
    }
    case "audio.segment":
      if (msg.state === "start") {
        t.segmentOpen = true;
        player?.startSegment(msg.segment);
      } else player?.endSegment(msg.segment);
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
      renderCost(v, run, t.turnId);
      setStatus(run.error ? `Finished with an error: ${run.error}` : "Ready.", !!run.error);
      break;
    }
  }
  scrollDown();
});

bindPushToTalk({ button: $("ptt"), onPress: () => press(), onRelease: () => void release() });
$("stop").onclick = () => stopAll();

/** Same rule as ptt.ts: Esc in a form control belongs to the control. */
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.repeat) return;
  const tg = e.target;
  if (tg instanceof HTMLElement && (tg.isContentEditable || tg instanceof HTMLInputElement || tg instanceof HTMLTextAreaElement || tg instanceof HTMLSelectElement)) return;
  stopAll();
});

// Live timers on running job cards, and the Stop button once queued audio has drained.
setInterval(() => {
  for (const c of jobs.values()) if (c.info.state === "running") renderJob(c);
  refreshBusy();
}, TICK_MS);

function clearConversation(): void {
  messages.querySelectorAll(".turn, .job, .note").forEach((n) => n.remove());
  views.clear();
  calls.clear();
  pendingResponses.clear();
  for (const id of jobs.keys()) droppedJobs.add(id);
  jobs.clear();
  renderJobsPill();
  $("empty").hidden = false;
  lastTargets = [];
  lastRests = [];
  drawOverlay();
}

$("reset").onclick = () => {
  if (turn && !turn.finished) cancelTurn(turn, "stop");
  stopNotice();
  player?.reset();
  playback.reset();
  sock.send({ type: "conversation.reset" });
  clearConversation();
  refreshBusy();
  setStatus("New conversation.");
};

// The server keeps the conversation (and its jobs) per WebSocket connection: after a reconnect it starts fresh.
{
  const render = sock.onStatus;
  let opened = false;
  sock.onStatus = (s) => {
    render?.(s);
    if (s !== "open") return;
    if (opened) {
      if (turn && !turn.finished) failTurn(turn, "Connection lost.");
      noticeJobId = null;
      for (const c of jobs.values()) {
        if (c.info.state !== "running") continue;
        c.info = { ...c.info, state: "failed", error: "Connection lost; the server dropped this task." };
        renderJob(c);
      }
      renderJobsPill();
    }
    if (opened && messages.querySelector(".turn")) {
      const note = el("p", "status err note", "Reconnected: the server started a new conversation (earlier turns are forgotten).");
      messages.append(note);
      scrollDown();
    }
    opened = true;
    refreshBusy();
  };
}

// ── ?demo=1: static sample conversation for layout review ──
if (DEMO) renderDemo();

function renderDemo(): void {
  /** Canned breakdown: router 10%, Opus 70% (when it's big), speech the rest. */
  const demoCost = (total: number): CostItem[] => total > 0.01
    ? [{ label: "Haiku router", usd: total * 0.05, detail: "in 312 + 2,227 cached · out 170" }, { label: "Opus", usd: total * 0.7, detail: "in 134 + 10,214 cached · out 769" },
      { label: "ElevenLabs TTS (eleven_v4_turbo)", usd: total * 0.24, detail: "ack 40 · filler 41 · answer 179 chars" }, { label: "Scribe STT", usd: total * 0.01, detail: "2.2 s" }]
    : [{ label: "Haiku router", usd: total * 0.3, detail: "in 312 + 2,227 cached · out 120" }, { label: "ElevenLabs TTS (eleven_v4_turbo)", usd: total * 0.68, detail: "answer 45 chars" }, { label: "Scribe STT", usd: total * 0.02, detail: "1.4 s" }];
  const metrics = (ttfa: number, tta: number | null, opusTotal: number | null) =>
    ({ ttfa, tta, opusTotal, stt: null, llmFirst: null, toolCall: null, opusFirst: null, opusSpoken: null, ttsFirst: null });
  const sample = (label: string) =>
    ({ t: 0, x: 0, y: 0, scrollX: 0, scrollY: 0, elementPath: null, dataSource: null, label });
  const turnOf = (id: string, approach: ChatApproach, user: string, bot: string, d: DecisionLike | null) => {
    const v = addTurnView(id, approach);
    v.user.classList.remove("pending");
    v.user.textContent = user;
    if (d) renderDecision(v, d);
    v.bot.hidden = false;
    v.botText.data = bot;
    return v;
  };

  const t1 = turnOf("demo-1", "pipeline", "Compare our three plans against the two main competitors.",
    "Sure, that'll take a couple of minutes. I'll work on it in the background and tell you when it's ready.",
    { intent: "task", estimateS: 95, background: true });
  renderMeta(t1, { metrics: metrics(612, 1840, null), costUsd: 0.0021 });
  renderCost(t1, { costUsd: 0.0021, costItems: demoCost(0.0021) }, t1.root.dataset.turn ?? "");

  const t2 = turnOf("demo-2", "hybrid", "Can you make this bigger?",
    "Do you mean the hero image or the headline above it?", { intent: "clarify", estimateS: null, background: false });
  renderChips(t2, [{ word: "this", wordStart: 1.1, algorithm: SHOWN_ALGORITHM, sample: sample("Hero image") }], "hybrid");
  renderMeta(t2, { metrics: metrics(488, 488, null), costUsd: 0.0009 });
  renderCost(t2, { costUsd: 0.0009, costItems: demoCost(0.0009) }, t2.root.dataset.turn ?? "");

  const t3 = turnOf("demo-3", "pipeline", "Why is the checkout button greyed out?",
    "Let me check that. Looking at the form state now… Got it: the button stays disabled until the email field validates, and the address there is missing its domain.",
    { intent: "question", estimateS: 8, background: false });
  t3.detail.hidden = false;
  t3.detailPre.textContent = "The submit button binds `disabled` to `!form.valid`.\n\nThe email input has value “dana@” which fails the pattern check, so `form.valid` is false. Fixing the address (or relaxing the pattern) enables the button.";
  renderMeta(t3, { metrics: metrics(540, 7320, 6900), costUsd: 0.0188 });
  renderCost(t3, { costUsd: 0.0188, costItems: demoCost(0.0188) }, t3.root.dataset.turn ?? "");

  const t4 = turnOf("demo-4", "realtime", "Summarise the pricing table for me.",
    "The pricing table has three tiers. The Starter plan is", { intent: "question", estimateS: 12, background: false });
  addTag(t4, "interrupted");

  // Romanian, with two pointing words and a cursor rest; drawn on the demo page too (once it's mounted).
  const t6 = turnOf("demo-6", "pipeline", "", "Gata: am mutat butonul „Get started” în cardul Drag-and-drop, sub titlul Live queries.",
    { intent: "task", estimateS: 6, background: false });
  const roWords: Word[] = [
    { text: "Mută", start: 0.0, end: 0.25 }, { text: "butonul", start: 0.3, end: 0.7 }, { text: "ăsta", start: 0.75, end: 0.95 },
    { text: "acolo,", start: 1.1, end: 1.4 }, { text: "sub", start: 1.6, end: 1.75 }, { text: "primul", start: 1.8, end: 2.1 },
    { text: "titlu.", start: 2.15, end: 2.5 },
  ];
  renderUserText(t6, "Mută butonul ăsta acolo, sub primul titlu.", roWords, "ro");
  const ref = (sel: string, label: string) => {
    const e = demoRoot.querySelector(sel);
    return { ...sample(label), ...(e ? describeElement(e as unknown as ElLike, demoRoot as unknown as ElLike) : {}) };
  };
  const roTargets = (): PointingTarget[] => [
    { word: "ăsta", wordStart: 0.75, algorithm: SHOWN_ALGORITHM, sample: ref(".cta", "Get started button"), ref: 1, wordIndex: 2 },
    { word: "acolo", wordStart: 1.1, algorithm: SHOWN_ALGORITHM, sample: ref(".card:nth-of-type(2) h3", "Card title: Drag-and-drop"), ref: 2, wordIndex: 3 },
  ];
  const roRests = (): CursorRest[] => [
    { ref: 1, tStart: 1800, tEnd: 2800, sample: ref(".card h3", "Card title: Live queries"), wordIndex: 6, whole: false },
  ];
  renderChips(t6, roTargets(), "pipeline", roRests(), 0);
  renderMeta(t6, { metrics: metrics(530, 2210, null), costUsd: 0.0016 });
  renderCost(t6, { costUsd: 0.0016, costItems: demoCost(0.0016) }, t6.root.dataset.turn ?? "");

  // English, no pointing word: only a cursor rest (the pointer stayed on the image the whole time).
  const t7 = turnOf("demo-7", "hybrid", "", "Sure, I'll make the Embeds card span the full width.", { intent: "task", estimateS: 4, background: false });
  const enWords: Word[] = [
    { text: "Make", start: 0.0, end: 0.2 }, { text: "it", start: 0.25, end: 0.35 }, { text: "a", start: 0.4, end: 0.45 },
    { text: "bit", start: 0.5, end: 0.65 }, { text: "wider.", start: 0.7, end: 1.1 },
  ];
  renderUserText(t7, "Make it a bit wider.", enWords, "en");
  renderChips(t7, [], "hybrid", [{ ref: 1, tStart: -200, tEnd: 1300, sample: sample("Card: Embeds"), wordIndex: 1, whole: true }], 0);
  renderMeta(t7, { metrics: metrics(470, 470, null), costUsd: 0.0007 });
  renderCost(t7, { costUsd: 0.0007, costItems: demoCost(0.0007) }, t7.root.dataset.turn ?? "");

  demoOverlay = () => { lastTargets = roTargets(); lastRests = roRests(); renderChips(t6, lastTargets, "pipeline", lastRests, 0); drawOverlay(); };

  turnOf("demo-5", "pipeline", "Audit every page for accessibility issues.",
    "On it. I'll keep going in the background and read you the results when I'm done.",
    { intent: "task", estimateS: 150, background: true });

  upsertJob({
    jobId: "job-1", turnId: "demo-1", approach: "pipeline", intent: "task", question: "Compare our three plans against the two main competitors.",
    estimateS: 95, state: "done", elapsedMs: 74_000,
    spoken: "SPOKEN: Done. We're cheapest at the top tier, but both competitors include SSO in their middle plan and we don't.",
    detail: "SPOKEN: Done. We're cheapest at the top tier…\n\nStarter: we're $2 above Acme and level with Globex.\nTeam: Globex and Acme both bundle SSO; we charge for it as an add-on.\nEnterprise: we're about 15% cheaper than either.\n\nSuggestion: move SSO into Team.",
  });
  upsertJob({
    jobId: "job-2", turnId: "demo-5", approach: "pipeline", intent: "task", question: "Audit every page for accessibility issues.",
    estimateS: 150, state: "running", elapsedMs: 37_000,
  });
  upsertJob({
    jobId: "job-3", turnId: "demo-x", approach: "hybrid", intent: "question", question: "Find every place we still call the old billing API.",
    estimateS: 40, state: "failed", elapsedMs: 12_000, error: "Opus: request timed out",
  });
  refreshBusy();
  setStatus("Demo conversation (static sample, ?demo=1).");
}
