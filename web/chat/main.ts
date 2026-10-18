// Chat sidebar of the Electron app: a multi-turn voice conversation (Scribe → router → TTS, hard questions to the
// solver) while pointing at the browser pane. Uses chat mode (RunConfig.memory): the server keeps the conversation.
// Per turn the server sends a `decision` (question / task / clarify / answer + estimate); short tasks get
// spoken fillers, long ones run as background `job`s whose results are read out later as a `notice`.
// The user can barge in (press while the assistant talks) or stop it (Esc / Stop button).
// Element threads (docs/PLAN-threads.md): the server's threads are kept here, listed by page, and the browser
// pane gets the ones on its page (markers, panel, bubbles: web/cursor/threadOverlay.ts).
import "./chat.css";
import { connectWithStatus } from "../common.ts";
import { languagesFor } from "../../shared/pointing.ts";
import { DEFAULT_CONFIG, isLocalStt, llmOf, type RunConfig } from "../../shared/config.ts";
import type { ClientMsg, CostItem, CursorRest, CursorSample, LlmPrompt, LlmResponse, PageEvents, JobInfo, MemorySnapshot, PointingTarget, RouteIntent, RunRecord, Segment, ServerMsg, Word } from "../../shared/protocol.ts";
import { stripVoiceCues } from "../../shared/cues.ts";
import { displayTitle, normalizePageUrl, type ThreadAnchor, type ThreadInfo, type ThreadSay } from "../../shared/threads.ts";
import { startCapture, warmCapture, type CaptureHandle } from "../audio/capture.ts";
import { warmUpAudio } from "../audio/context.ts";
import { createPlayer, type Player } from "../audio/player.ts";
import { bindPushToTalk, isPttKey, isTypingTarget } from "../audio/ptt.ts";
import { mountAlwaysListen, type AlwaysListenHandle } from "./alwaysListen.ts";
import { createRemotePage, isPageCommentAction, isPageOrbAction, isPageThreadAction, type ConvoEntry, type OrbPos, type OrbState, type PageBridge, type RemotePage } from "../cursor/pageBridge.ts";
import { typedSpanMs } from "../../shared/comment.ts";
import { STATE_LABEL } from "../cursor/threadOverlay.ts";
import { annotateTranscript, clickVerb, describeRef, relTime } from "../../shared/pointing.ts";
import { hasSpokenWords } from "../../shared/speech.ts";
import { autoSpeechTooShort, VAD_HANG_MAX_MS, VAD_HANG_MIN_MS, VAD_PRE_ROLL_MS } from "../audio/vad.ts";
import { addResponse, renderPrompt } from "./promptView.ts";
import { anchorKey, isQueuedId, queuedAnchor, queuedThreads as groupQueued, recordedMs, recordedPcm, shiftMsg, type QueueState, type Recorded, type TurnMsg } from "./queue.ts";
import { costBreakdown, fmtUsd, renderTurnCost, savingsOf, savingsText, type TurnCost } from "./costView.ts";
import { PlaybackClock, decisionBadges, detailOf, fmtBytes, fmtElapsed, fmtEstimate, groupThreads, jobHeadline, markerLabel, pageLabel, replyNeedsReply, runningLabel, spokenOf, threadsOnPage, type DecisionLike } from "./logic.ts";
import { PANEL_KEYS, SIDEBAR_KEYS, fishVoice, loadSettings, normalizeSettings, saveSettingsKeys, type ChatSettingsBridge } from "./settings.ts";

const PRE_ROLL_MS = 500;
const BATCH_MS = 100;
/** Give up on a turn that never gets turn.done (server hiccup). */
const TURN_TIMEOUT_MS = 90_000;
const TICK_MS = 250;
const SHOWN_ALGORITHM = "dwellMode";
/** The Electron app's preload (electron/preload.ts): push-to-talk and the browser pane, relayed from its process. */
const shell = (window as { shell?: {
  onPtt?: (cb: (down: boolean) => void) => void; page?: PageBridge; queue?: QueueBridge; mic?: MicBridge;
  chatSettings?: ChatSettingsBridge;
  getProject?: () => Promise<string | null>; pickProject?: () => Promise<string | null>;
  onProject?: (cb: (dir: string | null) => void) => void;
} }).shell;
/** The browser toolbar's Instant toggle and Send button (electron/preload.ts `queue`). */
interface QueueBridge {
  publish: (state: QueueState) => void;
  onCmd: (cb: (cmd: unknown) => void) => void;
}

/** The browser toolbar's mic (electron/preload.ts `mic`): Always listen, the talk state and the level, mirrored. */
interface MicBridge {
  publish: (state: { ready: boolean; always: boolean; live: boolean; threshold: number }) => void;
  level: (rms: number) => void;
  onCmd: (cb: (cmd: unknown) => void) => void;
}

/** Who the reply bubbles are from. */
const BOT_LABEL = "Assistant";

// The settings the Settings window changes arrive through chatSettings.onChanged (applied below the layout); the
// sidebar saves only its own (SIDEBAR_KEYS).
const settings = loadSettings(shell?.chatSettings);
const saveSettings = () => saveSettingsKeys(shell?.chatSettings, settings, SIDEBAR_KEYS);

// ── layout ─────────────────────────────────────────
const app = document.getElementById("app")!;
app.classList.add("chat");
app.innerHTML = `
<aside class="chat-side">
  <section class="panel chat-head">
    <div class="head-row opts">
      <span class="jobs-pill" id="jobs-pill" hidden></span>
      <span class="session-cost" id="session-cost" hidden title="This conversation: what was billed, and what subscriptions (Claude Code, Codex, Grok) and on-device speech saved"></span>
      <span class="session-mem" id="session-mem" hidden></span>
      <span class="spacer"></span>
    </div>
  </section>
  <section class="panel project" id="project" hidden>
    <span class="project-label">Project</span>
    <button type="button" id="project-pick" title="Choose project folder (⌘O)" aria-label="Choose project folder">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
      <span id="project-name">Choose folder…</span>
    </button>
    <span class="project-path" id="project-path"></span>
  </section>
  <section class="panel threads" id="threads" hidden>
    <details id="threads-box" open><summary id="threads-sum">Threads</summary><div class="thread-all"><button type="button" class="thread-bulk" id="threads-clear" title="Delete every thread, on every page">Delete all threads</button></div><div class="thread-groups" id="threads-list"></div></details>
  </section>
  <section class="panel messages" id="messages" aria-live="polite">
    <button type="button" class="conv-reset" id="reset" title="Forget the conversation on the server (also drops background tasks)">New conversation</button>
    <div class="empty" id="empty">
      <h3>Speak</h3>
      <p>Hover the mouse over an element while you talk to include it. Click or select text to point at “this” or “that”.</p>
      <h3>Type</h3>
      <p>Hold <b>Caps Lock</b> (or use the pointer button) and click an element. <b>Esc</b> cancels.</p>
    </div>
  </section>
  <section class="panel talk">
    <div class="listen-row">
      <label class="always" title="Start a turn when the microphone crosses the line. A few seconds below the line (set beside it), or Shift, sends it.">
        <input type="checkbox" id="always-listen"> Always listen
      </label>
      <span class="info" id="meter-hint" hidden>
        <button type="button" class="info-icon" aria-label="How Always listen works" aria-describedby="meter-tip">i</button>
        <span class="info-tip" id="meter-tip" role="tooltip">Drag the line to set the minimum. Crossing it starts a turn; staying below it for the set time, or Shift, sends the turn. A bump, or a clip with no words, is ignored.</span>
      </span>
      <label class="hang" id="hang-row" hidden title="How long the level must stay below the line before the turn is sent">
        Send after <input type="number" id="listen-hang" min="${VAD_HANG_MIN_MS / 1000}" max="${VAD_HANG_MAX_MS / 1000}" step="0.5" inputmode="decimal"> s below the line
      </label>
    </div>
    <canvas id="meter" class="meter" hidden role="slider" aria-orientation="vertical" aria-label="Minimum microphone level" tabindex="-1"></canvas>
    <div class="row">
      <button id="enable" title="Allow microphone access and start audio playback">Enable mic &amp; audio</button>
      <button id="ptt" class="ptt-big" disabled title="Hold to talk, release to send (or hold Shift). Press while it's talking to interrupt.">Hold to talk</button>
      <button id="stop" class="stop" hidden title="Stop speaking (Esc)">Stop</button>
    </div>
    <p class="status" id="status"></p>
  </section>
</aside>`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const messages = $("messages");

function setStatus(text: string, isErr = false): void {
  const el = $("status");
  el.textContent = text;
  el.classList.toggle("err", isErr);
}

function readyStatus(): string {
  return settings.alwaysListen
    ? "Always listen is on: talk when the meter crosses the line. Press Shift while it's talking to interrupt; Esc stops it."
    : "Hold Shift or the button to talk. Press again to interrupt; Esc stops.";
}

// ── settings ───────────────────────────────────────
// Changed in the Settings window (web/settings/main.ts); each applies from the next turn.
// The server's saved selection is what its agents are warm for: send it with each turn.
fetch("/api/llm/selection").then((r) => r.json()).then((sel: RunConfig["llm"]) => { settings.llm = llmOf({ llm: sel }); }).catch(() => {});
// The server loads only the selected on-device Voice / Speech engines; it may have started with an older selection
// (the Settings window sends each change itself).
void fetch("/api/speech/selection", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tts: settings.ttsModel, stt: settings.sttModel }) }).catch(() => {});
shell?.chatSettings?.onChanged?.((json) => {
  let next;
  try { next = normalizeSettings(JSON.parse(json)); } catch { return; }
  const prev = { ...settings };
  Object.assign(settings, Object.fromEntries(PANEL_KEYS.map((key) => [key, next[key]])));
  if (settings.sttModel !== prev.sttModel) for (const q of queue) transcribeQueued(q); // an on-device model: transcribe what's queued
  if (settings.debugOutlines !== prev.debugOutlines || settings.hoverOutline !== prev.hoverOutline) sendDebug();
  renderDisplay();
});

function sendDebug(): void {
  bridge.send({ type: "debug", outlines: settings.debugOutlines, hover: settings.hoverOutline });
}

function config(): RunConfig {
  return {
    ...DEFAULT_CONFIG,
    approach: "pipeline",
    routerMode: settings.routerMode,
    ttsModel: settings.ttsModel,
    sttModel: settings.sttModel,
    ...(settings.ttsModel === "fish_drama_3" ? { ttsVoice: fishVoice(settings) } : settings.ttsVoices[settings.ttsModel] ? { ttsVoice: settings.ttsVoices[settings.ttsModel] } : {}),
    ttsStyle: settings.ttsStyle,
    prewarm: true,
    memory: true,
    threads: true,
    fillers: true,
    backgroundLongTasks: true,
    longTaskSeconds: settings.longTaskSeconds,
    language: settings.language,
    llm: settings.llm,
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

function addTurnView(turnId: string): TurnView {
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
  bot.append(el("span", "who", BOT_LABEL), botText);
  const detail = el("details", "detail");
  detail.hidden = true;
  const detailPre = el("pre");
  detail.append(el("summary", undefined, "The solver's detailed answer"), detailPre);
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

function renderChips(v: TurnView, targets: PointingTarget[], rests: CursorRest[] = [], tAudioStart?: number): void {
  v.chips.replaceChildren();
  v.targets = targets;
  v.rests = rests;
  for (const t of targets.filter((x) => x.algorithm === SHOWN_ALGORITHM)) {
    const c = el("span", "chip");
    c.append(el("b", undefined, `${t.ref !== undefined ? `[${t.ref}] ` : ""}“${t.word}”`), ` → ${shortTarget(t)}`);
    v.chips.append(c);
  }
  for (const r of rests) {
    const c = el("span", "chip rest");
    c.append(el("b", undefined, `[@${r.ref}]`), ` rested on ${r.sample.label || r.sample.elementPath?.split(">").pop()?.trim() || "(element)"}`);
    c.title = `${describeRef(r.sample) || "(element)"} · ${restSpan(r, tAudioStart)}${r.whole ? " · whole time" : ""}`;
    if (r.whole) c.append(el("span", "whole", " · whole time"));
    v.chips.append(c);
  }
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
  if (run.metrics.solverTotal != null) add(`solver ${fmtMs(run.metrics.solverTotal)}`);
  if (run.error) add(run.error, "err");
}

/** Show the turn's itemized cost (plus any background task it started). */
function renderCost(v: TurnView, run: Pick<RunRecord, "costUsd" | "costItems">, turnId: string): void {
  const jobCosts = jobsOfTurn(turnId).map(jobCost);
  v.cost = { items: run.costItems ?? [{ label: "total", usd: run.costUsd }], total: run.costUsd, jobs: jobCosts };
  if (!v.costBox) { v.costBox = el("div", "costbox"); v.meta.after(v.costBox); }
  renderTurnCost(v.costBox, v.cost);
}

/** The turn's background tasks that have (or will have) a cost: running, or finished with a cost reported. */
const jobsOfTurn = (turnId: string) =>
  [...jobs.values()].filter((c) => c.info.turnId === turnId && (c.info.state === "running" || c.info.costUsd !== undefined));

const jobCost = (c: { info: JobInfo }): TurnCost["jobs"][number] => ({
  label: "background task", items: c.info.costItems ?? [], total: c.info.costUsd ?? 0, running: c.info.state === "running",
});

/** A job's cost changed: refresh the cost of the turn that started it. */
function refreshTurnCost(turnId: string): void {
  const v = views.get(turnId);
  if (!v?.cost || !v.costBox) return;
  v.cost.jobs = jobsOfTurn(turnId).map(jobCost);
  renderTurnCost(v.costBox, v.cost);
  renderSessionCost();
}

/**
 * Running totals for the conversation: billed, and saved by source (turns + their background tasks + thread runs
 * outside a turn; a thread's items from a turn are already in that turn).
 */
function renderSessionCost(): void {
  let billed = 0;
  const items: CostItem[] = [];
  for (const v of views.values()) {
    if (!v.cost) continue;
    billed += v.cost.total;
    items.push(...v.cost.items);
  }
  for (const c of jobs.values()) {
    billed += c.info.costUsd ?? 0;
    items.push(...(c.info.costItems ?? []));
  }
  for (const t of threads.values()) {
    const own = (t.costItems ?? []).filter((i) => !i.turnId);
    billed += own.reduce((n, i) => n + i.usd, 0);
    items.push(...own);
  }
  const el2 = $("session-cost");
  const saved = savingsText(savingsOf(items));
  el2.hidden = billed === 0 && !saved;
  el2.textContent = `spent ${fmtUsd(billed)}${saved ? ` · ${saved}` : ""}`;
}

// ── background job cards ───────────────────────────
interface JobCard {
  info: JobInfo;
  /** performance.now() when the job started (approx: first seen minus elapsedMs). */
  tStart: number;
  /** The clickable marker in the conversation; toggles `root`, the task's own thread. */
  marker: HTMLButtonElement;
  costBox: HTMLElement;
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
  const marker = el("button", "job-marker");
  marker.type = "button";
  marker.dataset.turn = info.turnId;
  marker.setAttribute("aria-expanded", "false");
  marker.title = "Show or hide this background job";
  const root = el("div", "job");
  root.dataset.turn = info.turnId;
  root.hidden = true;
  const head = el("div", "job-head");
  const question = el("div", "job-q");
  const sub = el("div", "job-sub");
  const spoken = el("div", "job-spoken");
  const detail = el("details", "detail");
  const detailPre = el("pre");
  detail.append(el("summary", undefined, "Detailed answer"), detailPre);
  const err = el("div", "job-err");
  const costBox = el("div", "costbox");
  costBox.hidden = true;
  root.append(head, question, sub, spoken, detail, err, costBox);
  const card: JobCard = { info, tStart: performance.now() - (info.elapsedMs ?? 0), marker, costBox, root, head, question, sub, spoken, detail, detailPre, err };
  marker.addEventListener("click", () => {
    root.hidden = !root.hidden;
    marker.setAttribute("aria-expanded", String(!root.hidden));
  });
  // After the starting turn (and after any earlier markers and cards of that turn); else at the end.
  let anchor: Element | null = views.get(info.turnId)?.root ?? null;
  while (anchor?.nextElementSibling instanceof HTMLElement && anchor.nextElementSibling.matches(`.job-marker[data-turn="${CSS.escape(info.turnId)}"], .job[data-turn="${CSS.escape(info.turnId)}"]`)) {
    anchor = anchor.nextElementSibling;
  }
  if (anchor) anchor.after(marker, root);
  else messages.append(marker, root);
  return card;
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
  orbChanged();
  refreshTurnCost(info.turnId);
}

function renderJob(c: JobCard): void {
  const j = c.info;
  c.root.dataset.state = j.state;
  c.marker.dataset.state = j.state;
  const status = j.state === "running" ? `${fmtElapsed(performance.now() - c.tStart)}…` : j.state === "failed" ? "failed" : j.costUsd !== undefined ? fmtUsd(j.costUsd) : "";
  const isCost = j.state !== "running" && j.state !== "failed" && j.costUsd !== undefined;
  c.marker.replaceChildren(el("span", "job-marker-q", `${j.intent === "question" ? "Question" : "Task"}: ${markerLabel(j.question)}`), el("span", isCost ? "job-marker-status cost-text" : "job-marker-status", status));
  c.head.textContent = jobHeadline(j, performance.now() - c.tStart);
  c.question.textContent = j.question ? `“${j.question}”` : "";
  c.question.hidden = !j.question;
  const est = fmtEstimate(j.estimateS);
  c.sub.textContent = j.state === "running" && est ? `estimate ${est}` : "";
  const spoken = j.state === "done" && j.spoken ? stripVoiceCues(spokenOf(j.spoken)) : "";
  c.spoken.textContent = spoken;
  c.spoken.hidden = !spoken;
  const detail = j.state === "done" && j.detail ? detailOf(j.detail) : "";
  c.detailPre.textContent = detail;
  c.detail.hidden = !detail;
  if (j.costUsd !== undefined) {
    const items = j.costItems ?? [];
    const saved = items.reduce((n, i) => n + (i.savedUsd ?? 0), 0);
    const parts = items.map((i) => `${i.label.replace(/ \(.*\)$/, "")} ${i.savedUsd !== undefined && i.usd === 0 ? `${fmtUsd(i.savedUsd)} saved` : fmtUsd(i.usd)}`);
    c.sub.append(el("span", "cost-text", ` · cost ${fmtUsd(j.costUsd)}${saved > 0 ? ` · ${fmtUsd(saved)} saved` : ""}${parts.length ? ` (${parts.join(", ")})` : ""}`));
    renderTurnCost(c.costBox, { items: items, total: j.costUsd, jobs: [] });
    c.costBox.hidden = false;
  }
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
/** The browser pane. Its preload records the pointer, clicks and highlights and draws the overlay. */
const bridge: PageBridge = shell!.page!;
const pageSource: RemotePage = createRemotePage(bridge);
let player: Player | null = null;
let lastTargets: PointingTarget[] = [];
let lastRests: CursorRest[] = [];
/** Rough "is something audible" estimate from bytes pushed vs time. */
const playback = new PlaybackClock();
/** Whose audio was pushed last, so a barge-in only tags a turn whose reply was actually cut off. */
let audioOwner: "turn" | "notice" | null = null;
/** What's being read out outside a turn (between notice / thread.say start and end): a jobId, or `say:<sayId>`. */
let noticeJobId: string | null = null;
/** Notices the user stopped or talked over: ignore the rest of their frames/messages. */
const stoppedNotices = new Set<string>();

function drawOverlay(): void {
  pageSource.overlay(lastTargets, lastRests, [SHOWN_ALGORITHM]);
}

async function enableAudio(): Promise<void> {
  try {
    await warmUpAudio();
    player ??= await createPlayer();
    await warmCapture(); // its worklet keeps the pre-roll an always-listen turn starts with
    player.onPlayed = (segment: Segment, tPlayed: number) => {
      // Marks only for the current turn's segments; notices aren't part of any turn.
      if (segment !== "notice" && turn && !turn.finished) sock.send({ type: "audio.played", turnId: turn.turnId, segment, tPlayed });
    };
    $("enable").hidden = true;
    $<HTMLButtonElement>("ptt").disabled = false;
    listen?.setAudioReady(true);
    setStatus(readyStatus());
  } catch (e) {
    $("enable").hidden = false;
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
  noticeAudio(msg.jobId, msg.state, "Reading out a background result…");
}

/** Audio spoken outside a turn (a job's result, a thread's line): its frames play between start and end. */
function noticeAudio(key: string, state: "start" | "end", what: string): void {
  if (stoppedNotices.has(key)) return;
  if (state === "start") {
    noticeJobId = key;
    player?.startSegment("notice");
    setStatus(settings.alwaysListen ? `${what} talk to interrupt, Esc to stop.` : `${what} (press to talk over it, Esc to stop)`);
  } else if (noticeJobId === key) {
    player?.endSegment("notice");
    noticeJobId = null;
    if (!turnBusy()) setStatus(readyStatus());
  }
  refreshBusy();
}

/** Stop the notice being read out (if any) and tell the server. */
function stopNotice(): void {
  if (!noticeJobId) return;
  stoppedNotices.add(noticeJobId);
  const say = pageSays.get(noticeJobId);
  if (say) { bridge.send({ type: "bubble", say, ended: true }); pageSays.delete(noticeJobId); }
  noticeJobId = null;
  sock.send({ type: "speech.stop" });
}

// ── element threads ────────────────────────────────
const threads = new Map<string, ThreadInfo>();
/** The browser pane's URL (threads are filtered by normalizePageUrl). */
let pageUrl: string | null = null;
/** A thread picked in the list on another page: opened once that page is loaded (its panel sends thread.focus). */
let pendingOpen: { threadId: string; pageUrl: string; until: number } | null = null;
/** Thread lines shown as bubbles on the page, by `say:<sayId>` (ended when stopped). */
const pageSays = new Map<string, ThreadSay>();

const onCurrentPage = (t: ThreadInfo | undefined): boolean => !!t && !!pageUrl && t.pageUrl === normalizePageUrl(pageUrl);

function threadsChanged(): void {
  // Queued feedback shows as teal markers next to the real threads (web/chat/queue.ts queuedThreads).
  bridge.send({ type: "threads", threads: threadsOnPage([...threads.values(), ...queuedThreads()], pageUrl) });
  renderThreadList();
  renderSessionCost();
}

function onPageUrl(url: string): void {
  pageUrl = url;
  sendDebug(); // a new document starts with outlines off
  threadsChanged();
  orbChanged(true);
  sendConversation(true);
  publishComment();
  // Sent again on every update until the page answers with thread.focus (the first may reach a document that isn't ready).
  if (pendingOpen && Date.now() > pendingOpen.until) pendingOpen = null;
  if (pendingOpen && normalizePageUrl(url) === pendingOpen.pageUrl) bridge.openThread?.(pendingOpen.threadId);
}

// Project folder: only in the Electron app. The solver works there; picking another restarts its agents there.
if (shell?.getProject && shell.pickProject && shell.onProject) {
  const { getProject, pickProject, onProject } = shell;
  const pick = $<HTMLButtonElement>("project-pick");
  // The initial getProject can resolve after a pick. Don't let that stale answer overwrite the newer one.
  let seenChange = false;
  const show = (dir: string | null) => {
    $("project-name").textContent = dir?.split("/").filter(Boolean).pop() || "Choose folder…";
    $("project-path").textContent = dir ?? "";
    pick.title = dir ? `Project folder: ${dir} (⌘O to change)` : "Choose project folder (⌘O)";
  };
  $("project").hidden = false;
  pick.onclick = async () => {
    pick.disabled = true;
    try {
      show(await pickProject());
    } finally {
      pick.disabled = false;
    }
  };
  onProject((dir) => { seenChange = true; show(dir); });
  void getProject().then((dir) => { if (!seenChange) show(dir); });
}

// RAM and cost figures stay rendered; turned off in Settings, they're hidden (chat.css: .hide-ram / .hide-cost).
function renderDisplay(): void {
  app.classList.toggle("hide-ram", !settings.showRam);
  app.classList.toggle("hide-cost", !settings.showCost);
}
renderDisplay();

/** From the list: open the thread's panel on the page, navigating there first if it's on another page. */
function openThread(t: ThreadInfo): void {
  if (onCurrentPage(t)) { bridge.openThread?.(t.threadId); return; }
  if (!bridge.navigate) return;
  pendingOpen = { threadId: t.threadId, pageUrl: t.pageUrl, until: Date.now() + 15_000 };
  bridge.navigate(t.pageUrl);
}

/** From the list's ×: no confirmation. Dropped here right away; the server's thread.removed follows. */
function deleteThread(threadId: string): void {
  if (pendingOpen?.threadId === threadId) pendingOpen = null;
  sock.send({ type: "thread.delete", threadId });
  threads.delete(threadId);
  threadsChanged();
}

/**
 * A bulk-delete button: the first click arms it ("Click again to delete N"), a second click within 3 s deletes.
 * `ids` is read at click time, so threads that arrive meanwhile are included.
 */
function bulkDelete(b: HTMLButtonElement, ids: () => string[]): void {
  const label = b.textContent ?? "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  b.onclick = () => {
    if (!b.classList.contains("armed")) {
      b.classList.add("armed");
      const n = ids().length;
      b.textContent = `Click again to delete ${n} thread${n === 1 ? "" : "s"}`;
      timer = setTimeout(() => { b.classList.remove("armed"); b.textContent = label; }, 3000);
      return;
    }
    clearTimeout(timer);
    b.classList.remove("armed");
    b.textContent = label;
    for (const id of ids()) deleteThread(id);
  };
}

bulkDelete($("threads-clear") as HTMLButtonElement, () => [...threads.keys()]);

function renderThreadList(): void {
  const groups = groupThreads(threads.values(), pageUrl);
  $("threads").hidden = groups.length === 0;
  const running = [...threads.values()].filter((t) => t.state === "running").length;
  const all = threadsCost(threads.values());
  const sum = $("threads-sum");
  const allMem = el("span", "thread-mem-all");
  sum.replaceChildren(`Threads · ${threads.size}${running ? ` · ${running} working` : ""}`, allMem, ...(all ? [el("span", "cost-text", ` · ${fmtUsd(all.total)} total`)] : []));
  sum.title = all ? `All threads\n${costBreakdown(all.items, all.total)}` : "";
  $("threads-list").replaceChildren(...groups.map((g) => {
    const box = el("div", "thread-group");
    const head = el("div", "thread-page", pageLabel(g.pageUrl));
    head.title = g.pageUrl;
    if (g.current) head.append(el("span", "thread-here", " · this page"));
    const del = el("button", "thread-bulk", "Delete all");
    del.type = "button";
    del.title = `Delete every thread on ${g.pageUrl}`;
    bulkDelete(del, () => [...threads.values()].filter((t) => t.pageUrl === g.pageUrl).map((t) => t.threadId));
    const headRow = el("div", "thread-page-row");
    const pageCost = threadsCost(g.threads);
    const pageMem = el("span", "thread-mem");
    pageMem.dataset.page = g.pageUrl;
    if (pageCost) {
      const c = el("span", "thread-page-cost", fmtUsd(pageCost.total));
      c.title = `Threads on this page\n${costBreakdown(pageCost.items, pageCost.total)}`;
      headRow.append(head, pageMem, c, del);
    } else headRow.append(head, pageMem, del);
    box.append(headRow);
    for (const t of g.threads) {
      const b = el("button", "thread-item");
      b.type = "button";
      b.dataset.state = t.state;
      b.title = [stripVoiceCues(t.summary), g.current ? "Open its panel on the page" : `Go to ${pageLabel(g.pageUrl)} and open its panel`].filter(Boolean).join("\n");
      const mem = el("span", "thread-mem");
      mem.dataset.thread = t.threadId;
      b.append(el("span", "thread-dot"), el("span", "thread-title", displayTitle(t.title)), ...(t.unread ? [el("span", "thread-unread", "")] : []), mem, threadStatus(t));
      if (t.unread) b.querySelector(".thread-unread")!.setAttribute("aria-label", "unread");
      b.onclick = () => openThread(t);
      const x = el("button", "thread-del", "×");
      x.type = "button";
      x.title = "Delete this thread";
      x.setAttribute("aria-label", `Delete thread: ${t.title}`);
      x.onclick = () => deleteThread(t.threadId);
      const row = el("div", "thread-row");
      row.append(b, x);
      box.append(row);
    }
    return box;
  }));
  renderMemory();
}

/** The latest RAM sample from the server (server/memory.ts), null until the first. */
let memory: MemorySnapshot | null = null;

/**
 * RAM per thread (its own harness process), per page (its threads together) and for the whole app server, written
 * into the spans renderThreadList made, so a sample every few seconds doesn't rebuild the list.
 */
function renderMemory(): void {
  const head = $("session-mem");
  head.hidden = !memory;
  if (!memory) return;
  const m = memory;
  const threadsBytes = Object.values(m.threads).reduce((n, b) => n + b, 0);
  head.textContent = `RAM ${fmtBytes(m.totalBytes)}`;
  const speechBytes = m.speechBytes ?? 0;
  head.title = [
    "RAM the app server uses now: its Node process and every process it started (physical footprint, GPU memory included)",
    `Server (Node): ${fmtBytes(m.serverBytes)}`,
    `Threads' own harness processes: ${fmtBytes(threadsBytes)}`,
    ...(speechBytes ? [`On-device speech models: ${fmtBytes(speechBytes)}`] : []),
    `Other (warm agents, shared Codex/OpenCode servers, Grok runs): ${fmtBytes(Math.max(0, m.totalBytes - m.serverBytes - threadsBytes - speechBytes))}`,
  ].join("\n");
  const allMem = $("threads-sum").querySelector<HTMLElement>(".thread-mem-all");
  if (allMem) {
    allMem.textContent = threadsBytes ? ` · ${fmtBytes(threadsBytes)}` : "";
    allMem.title = threadsBytes ? "RAM of every thread's harness process (and its children)" : "";
  }
  const box = $("threads-list");
  for (const s of box.querySelectorAll<HTMLElement>(".thread-mem[data-thread]")) {
    const b = m.threads[s.dataset.thread!];
    s.textContent = b ? fmtBytes(b) : "";
    s.title = b ? "RAM of this thread's harness process (and its children)" : "";
  }
  for (const s of box.querySelectorAll<HTMLElement>(".thread-mem[data-page]")) {
    const b = [...threads.values()].filter((t) => t.pageUrl === s.dataset.page).reduce((n, t) => n + (m.threads[t.threadId] ?? 0), 0);
    s.textContent = b ? fmtBytes(b) : "";
    s.title = b ? "RAM of this page's threads' harness processes" : "";
  }
}

/** Billed cost of these threads together (null: none has a cost yet). */
function threadsCost(list: Iterable<ThreadInfo>): { total: number; items: CostItem[] } | null {
  const costed = [...list].filter((t) => t.costUsd !== undefined);
  if (!costed.length) return null;
  return { total: costed.reduce((n, t) => n + t.costUsd!, 0), items: costed.flatMap((t) => t.costItems ?? []) };
}

/**
 * What the thread cost so far (billed, not saved; the turns routed to it included), its components on hover; a
 * thread still working shows its state too. No cost yet: just its state.
 */
function threadStatus(t: ThreadInfo): HTMLElement {
  const finished = t.state === "idle" || t.state === "pending";
  if (t.costUsd === undefined) return el("span", "thread-state", STATE_LABEL[t.state]);
  const cost = el("span", "cost-text", finished ? fmtUsd(t.costUsd) : ` · ${fmtUsd(t.costUsd)} so far`);
  cost.title = costBreakdown(t.costItems ?? [], t.costUsd);
  const s = el("span", "thread-state thread-cost");
  s.append(...(finished ? [] : [STATE_LABEL[t.state]]), cost);
  return s;
}

/** A thread's line outside a turn: a bubble from its marker when it's on this page, else in the conversation. */
function onThreadSay(msg: Extract<ServerMsg, { type: "thread.say" }>): void {
  const { say, state } = msg;
  const key = `say:${say.sayId}`;
  const t = say.threadId ? threads.get(say.threadId) : undefined;
  if (state === "start") {
    // Central lines come from the orb, and stay in the conversation too (the orb's panel shows it).
    if (onCurrentPage(t) || say.threadId === null) { bridge.send({ type: "bubble", say, ended: false }); pageSays.set(key, say); }
    if (!onCurrentPage(t)) addSayBubble(say, t);
  } else if (pageSays.has(key)) {
    // Ended once its audio has drained.
    const ended = pageSays.get(key)!;
    pageSays.delete(key);
    setTimeout(() => bridge.send({ type: "bubble", say: ended, ended: true }), playback.remainingMs(performance.now()));
  }
  noticeAudio(key, state, t ? `Telling you about ${t.title}…` : "Speaking…");
}

function addSayBubble(say: ThreadSay, t: ThreadInfo | undefined): void {
  $("empty").hidden = true;
  const root = el("div", "turn say");
  const bot = el("div", `bubble bot${say.needsReply ? " reply" : ""}`);
  if (t) {
    const who = el("button", "who link", `${displayTitle(t.title)} · ${pageLabel(t.pageUrl)}`);
    who.type = "button";
    who.title = "Open this thread";
    who.onclick = () => { const cur = threads.get(t.threadId); if (cur) openThread(cur); };
    bot.append(who);
  } else bot.append(el("span", "who", say.threadId ? "Thread" : "Conversation"));
  bot.append(stripVoiceCues(say.text));
  root.append(bot);
  messages.append(root);
  scrollDown();
}

/**
 * The turn's spoken reply as a bubble from its thread's marker (on this page), or from the orb when it went to no
 * thread (the central conversation). Synthetic sayId per turn.
 */
function sendTurnBubble(t: Turn, ended: boolean): void {
  const line = t.voice.slice(t.lineStart).trim();
  if (t.bubbleEnded || !line) return;
  if (t.intent === undefined) return; // the decision says which marker it comes from
  const th = t.threadId ? threads.get(t.threadId) : undefined;
  if (th && !onCurrentPage(th)) return; // on another page: the turn's own bubble here shows it
  const say: ThreadSay = { sayId: `turn:${t.turnId}`, threadId: t.threadId ?? null, text: line, needsReply: replyNeedsReply(t.intent, line) };
  if (!ended) { bridge.send({ type: "bubble", say, ended: false }); return; }
  t.bubbleEnded = true;
  setTimeout(() => {
    bridge.send({ type: "bubble", say, ended: true });
    if (say.threadId === null && say.needsReply && turn === t) { centralAsking = true; orbChanged(); }
  }, playback.remainingMs(performance.now()));
}

bridge.onThreadAction?.((a) => {
  if (isPageOrbAction(a)) {
    settings.orbPos = a.pos;
    saveSettings();
    return;
  }
  if (!isPageThreadAction(a)) return;
  if (pendingOpen?.threadId === a.threadId) pendingOpen = null;
  // Queued feedback isn't on the server: its panel's Delete drops it, and the rest queued on that element, from the queue.
  if (isQueuedId(a.threadId)) {
    const anchor = queue.find((x) => queuedThreadId(x) === a.threadId)?.anchor;
    if (a.type === "thread.delete" && anchor) {
      for (const q of queue.filter((x) => x.anchor && anchorKey(x.anchor) === anchorKey(anchor))) removeQueued(q);
    }
    return;
  }
  sock.send(a);
});
bridge.onUrl?.((url) => { if (typeof url === "string") onPageUrl(url); });
void bridge.getUrl?.().then((url) => { if (typeof url === "string" && url && !pageUrl) onPageUrl(url); }).catch(() => {});

// ── turn flow ──────────────────────────────────────
/** Where a turn's messages go: the server, or a recording (queued feedback). */
interface TurnOut {
  send(msg: TurnMsg): void;
  sendAudio(pcm: Int16Array<ArrayBuffer>): void;
}
interface Turn {
  out: TurnOut;
  /** Recorded for the queue instead of sent (Instant off). */
  rec?: Recorded[];
  /** Resolved by endTurn (the queue sends the next turn after this one). */
  onEnd?: () => void;
  /** Client time of the first captured audio sample (page-event times are shown relative to it). */
  tAudioStart?: number;
  turnId: string;
  tPress: number;
  tRelease?: number;
  /** Ended by always-listen. A wordless result is dropped instead of shown. */
  auto?: boolean;
  capture?: CaptureHandle;
  audioStarted: Promise<void>;
  sentUpTo: number;
  /** Elements whose details were sent this turn, and whether they had React info (sent again once it arrives). */
  detailed: Map<string, boolean>;
  batchTimer?: ReturnType<typeof setInterval>;
  timeout?: ReturnType<typeof setTimeout>;
  view: TurnView;
  voice: string;
  /** Where the last spoken line starts in `voice`: the page bubble shows only that line. */
  lineStart: number;
  solver: string;
  /** Got an audio.segment start: binary frames are now this turn's. */
  segmentOpen: boolean;
  finished: boolean;
  /** Its clicks / highlights were sent and the page reset (the recorder belongs to the next turn now). */
  pageDone?: boolean;
  /** decision: the route and, with element threads, the thread the turn went to (its reply bubbles from that marker). */
  intent?: RouteIntent;
  threadId?: string;
  bubbleEnded?: boolean;
  /** A typed comment: answered in text only (RunConfig.silent). */
  silent?: boolean;
}
let turn: Turn | null = null;
/** This recording was opened by the meter. Silence or one Shift sends it; a held Shift/button is separate. */
let meterTurn = false;
/** Set once the talk controls are mounted (the mic tap starts after enableAudio). */
let listen: AlwaysListenHandle | null = null;
/** Still capturing this turn or a dictation (Shift is held, the button is held, or the meter is open). */
function isRecording(): boolean {
  return (!!turn && !turn.finished && turn.tRelease === undefined) || (!!dictation && !dictation.released);
}
/** Turns we cancelled: their late messages are ignored (a late turn.done still renders metrics). */
const cancelled = new Set<string>();

/** Released and waiting for / playing the reply. */
function turnBusy(): boolean {
  return !!turn && !turn.finished && turn.tRelease !== undefined;
}

/** Show the Stop button while the assistant is thinking/speaking or a notice is audible. */
function refreshBusy(): void {
  $("stop").hidden = !(turnBusy() || noticeJobId || playback.isPlaying(performance.now()));
  orbChanged();
}

// ── the conversation orb ───────────────────────────
// The orb on the page stands for the central conversation (web/cursor/threadOverlay.ts): it's listening while a turn
// or a dictation is being recorded, working while a turn that went to no thread (or hasn't been routed yet) or a
// background job is running, and asking once a central reply ended on a question for you, until the next turn. Its
// panel shows the conversation as it is here.

let orbSent: string | null = null;
/** The last central reply asked you something (a follow-up, or ended with "?"); cleared by the next turn. */
let centralAsking = false;

function orbState(): OrbState {
  const t = turn;
  const turnCentral = !!t && !t.finished && t.tRelease !== undefined && !t.rec && !t.threadId;
  const jobRunning = [...jobs.values()].some((c) => c.info.state === "running");
  if (isRecording()) return "listening";
  if (turnCentral || jobRunning) return "running";
  return centralAsking ? "asking" : "idle";
}

/** Sends the orb's state and position when they changed (`force`: a new document). */
function orbChanged(force = false): void {
  const cmd = { type: "orb" as const, state: orbState(), pos: settings.orbPos };
  const key = JSON.stringify(cmd);
  if (!force && key === orbSent) return;
  orbSent = key;
  bridge.send(cmd);
}

/** The text of a node without its child elements' (a bubble's "who" label, the language tag). */
const ownText = (n: Element): string => [...n.childNodes].filter((c) => c.nodeType === Node.TEXT_NODE).map((c) => c.textContent).join("").trim();

/** The conversation as shown here, in order: turns, background jobs and lines said outside a turn. */
function conversationEntries(): ConvoEntry[] {
  const out: ConvoEntry[] = [];
  for (const n of messages.children) {
    if (n.classList.contains("job")) {
      const c = [...jobs.values()].find((j) => j.root === n);
      if (!c) continue;
      const spoken = c.spoken.hidden ? "" : c.spoken.textContent ?? "";
      const err = c.err.hidden ? "" : c.err.textContent ?? "";
      out.push({
        id: `job:${c.info.jobId}`, user: null, who: c.head.textContent ?? "Background task", badges: [],
        assistant: spoken || err || (c.question.hidden ? "" : c.question.textContent ?? ""),
        ...(c.detail.hidden ? {} : { detail: c.detailPre.textContent ?? "" }),
      });
    } else if (n.classList.contains("say")) {
      const bot = n.querySelector(".bubble.bot");
      if (!bot) continue;
      out.push({ id: `say:${out.length}`, user: null, who: bot.querySelector(".who")?.textContent ?? undefined, assistant: ownText(bot), badges: [] });
    } else if (n.classList.contains("turn")) {
      const id = (n as HTMLElement).dataset.turn;
      const v = id ? views.get(id) : undefined;
      if (!id || !v) continue;
      const badges = [...v.badges.querySelectorAll(".badge, .tag")].map((b) => b.textContent ?? "").filter(Boolean);
      out.push({
        id, user: ownText(v.user) || (v.user.textContent ?? ""), assistant: v.bot.hidden ? "" : v.botText.data, badges,
        ...(v.detail.hidden ? {} : { detail: v.detailPre.textContent ?? "" }),
        ...(n.classList.contains("queued") ? { note: "not sent yet" } : {}),
      });
    }
  }
  return out;
}

const CONVO_THROTTLE_MS = 200;
let convoTimer: ReturnType<typeof setTimeout> | null = null;
let convoSent: string | null = null;

/** Sends the page the conversation when it changed (at most every CONVO_THROTTLE_MS; `now`: a new document). */
function sendConversation(now = false): void {
  const flush = () => {
    convoTimer = null;
    const entries = conversationEntries();
    const key = JSON.stringify(entries);
    if (!now && key === convoSent) return;
    convoSent = key;
    bridge.send({ type: "conversation", entries });
  };
  if (now) { if (convoTimer) clearTimeout(convoTimer); flush(); return; }
  convoTimer ??= setTimeout(flush, CONVO_THROTTLE_MS);
}
new MutationObserver(() => sendConversation()).observe(messages, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "class"] });

function flushSamples(t: Turn): void {
  const fresh = pageSource.range(t.tPress - PRE_ROLL_MS).filter((s) => s.t > t.sentUpTo);
  if (!fresh.length) return;
  t.sentUpTo = fresh[fresh.length - 1]!.t;
  // The page sends an element's details when the pointer reaches it, maybe before this turn: attach them to the turn's
  // first sample on it (and once more when its React info arrives later).
  const samples = fresh.map((s) => {
    if (!s.elementPath) return s;
    const details = s.details ?? pageSource.details(s.elementPath);
    const sent = t.detailed.get(s.elementPath);
    if (!details || sent === true || (sent === false && !details.react)) return s.details ? { ...s, details: undefined } : s;
    t.detailed.set(s.elementPath, !!details.react);
    return { ...s, details };
  });
  t.out.send({ type: "cursor.samples", turnId: t.turnId, samples });
}

/** Cancel an unfinished turn now (don't wait for turn.done) and tag its view; keeps what was said so far. */
function cancelTurn(t: Turn, reason: "interrupt" | "stop"): void {
  if (t.finished) return;
  if (t.rec) return dropRecording(t);
  if (sending) stopSending(); // the user talked over a queued turn, or stopped it: the rest stay queued
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

function press(how: "manual" | "vad" = "manual"): void {
  if (!player) return setStatus("Click “Enable mic & audio” first.", true);
  if (commentOpen) return startDictation(how); // a comment bubble is open: talking fills it in
  const queued = !settings.instant;
  if (!queued && !sock.isOpen) return setStatus("Server not connected.", true);
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
  const rec: Recorded[] | undefined = queued ? [] : undefined;
  const out: TurnOut = rec
    ? { send: (msg) => rec.push({ msg }), sendAudio: (pcm) => rec.push({ pcm: pcm.slice() }) }
    : { send: (msg) => sock.send(msg), sendAudio: (pcm) => sock.sendAudio(pcm) };
  const t: Turn = {
    out, rec, turnId, tPress: now, audioStarted: Promise.resolve(),
    sentUpTo: now - PRE_ROLL_MS - 1, detailed: new Map(), view: addTurnView(turnId), voice: "", lineStart: 0, solver: "", segmentOpen: false, finished: false,
  };
  turn = t;
  centralAsking = false;
  lastTargets = [];
  lastRests = [];
  drawOverlay();
  // A queued turn records its page; its config is the sidebar's when it's sent.
  out.send({ type: "turn.start", turnId, config: config(), tPress: now, ...(queued && pageUrl ? { pageUrl: normalizePageUrl(pageUrl) } : {}) });
  pageSource.start(now - PRE_ROLL_MS);
  t.batchTimer = setInterval(() => flushSamples(t), BATCH_MS);
  $("ptt").classList.add("live");
  if (how === "vad") $("ptt").textContent = "Listening…";
  setStatus(how === "vad"
    ? `Listening… two seconds under the line ${queued ? "queues" : "sends"} it, or press Shift.`
    : queued ? "Listening… release to queue it." : "Listening… release to send.");
  refreshBusy();
  publishComment();
  t.audioStarted = (async () => {
    try {
      t.capture = await startCapture({
        onFrame: (pcm) => { if (turn === t && t.tRelease === undefined && !t.finished) out.sendAudio(pcm); },
        preRollMs: how === "vad" ? VAD_PRE_ROLL_MS : 0,
      });
      const tAudioStart = await t.capture.tAudioStart;
      t.tAudioStart = tAudioStart;
      if (!t.finished) out.send({ type: "turn.audioStart", turnId, tAudioStart });
    } catch (e) {
      failTurn(t, `Mic: ${(e as Error).message}`);
    }
  })();
}

function heardWords(t: Turn): boolean {
  const text = t.view.user.textContent ?? "";
  if (text === "listening…" || text === "…") return false;
  return hasSpokenWords(text);
}

/** Always-listen ended on a bump: cancel the turn and remove its bubble. Nothing is transcribed. */
function discardAutoTurn(t: Turn): void {
  if (t.finished || t.tRelease !== undefined) return;
  if (!t.rec) sock.send({ type: "turn.cancel", turnId: t.turnId, reason: "stop" });
  cancelled.add(t.turnId);
  endTurn(t);
  t.view.root.remove();
  views.delete(t.turnId);
  if (!messages.querySelector(".turn, .job, .job-marker")) $("empty").hidden = false;
  setStatus(readyStatus());
}

async function release(auto = false): Promise<void> {
  if (dictation && !dictation.released) return stopDictation();
  const t = turn;
  if (!t || t.finished || t.tRelease !== undefined) return;
  t.tRelease = performance.now();
  t.auto = auto;
  $("ptt").classList.remove("live");
  $("ptt").textContent = "Hold to talk";
  publishComment();
  await t.audioStarted;
  t.capture?.stop();
  if (turn !== t || t.finished) return;
  const page = await pageSource.stop();
  if (turn !== t || t.finished) return;
  flushSamples(t);
  clearInterval(t.batchTimer);
  // A question's highlights are sent with it; they shouldn't linger or carry over to the next one.
  pageSource.clear();
  t.pageDone = true;
  t.out.send({ type: "turn.context", turnId: t.turnId, ...page });
  renderPageChips(t.view, page, t.tAudioStart);
  t.out.send({ type: "turn.release", turnId: t.turnId, tRelease: t.tRelease, ...(auto ? { auto: true } : {}) });
  if (t.rec) return enqueue(t);
  // Element threads: a provisional marker on the element under the pointer until the decision names the thread.
  bridge.send({ type: "provisional", turnId: t.turnId });
  if (!auto) setStatus("Thinking…");
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
  const wasSending = sending;
  if (sending) stopSending();
  if (dictation) endDictation(dictation, undefined, true);
  if (t && !t.finished) cancelTurn(t, "stop");
  else if (t && turnAudible) addTag(t.view, "stopped");
  stopNotice();
  if (t || hadNotice || wasPlaying || wasSending) setStatus(queue.length ? `Stopped. ${queuedText()}` : "Stopped.");
  refreshBusy();
}

function endTurn(t: Turn): void {
  const wasRecording = t.tRelease === undefined;
  t.finished = true;
  // Esc, a failed mic, or a dropped connection ended a meter turn without the gate's own stop.
  if (turn === t && meterTurn && wasRecording) {
    meterTurn = false;
    listen?.disarm();
  }
  if (!t.pageDone) { pageSource.clear(); t.pageDone = true; } // cancelled / failed before release finished
  if (t.tRelease !== undefined) bridge.send({ type: "provisional.clear", turnId: t.turnId });
  sendTurnBubble(t, true);
  clearInterval(t.batchTimer);
  clearTimeout(t.timeout);
  t.capture?.stop();
  if (turn === t) {
    $("ptt").classList.remove("live");
    $("ptt").textContent = "Hold to talk";
  }
  refreshBusy();
  if (wasRecording) publishComment();
  t.onEnd?.();
}

function failTurn(t: Turn, msg: string): void {
  if (t.finished) return;
  if (!t.rec) sock.send({ type: "turn.cancel", turnId: t.turnId });
  cancelled.add(t.turnId);
  endTurn(t);
  if (t.view.user.classList.contains("pending")) t.view.user.textContent = "(cancelled)";
  t.view.meta.append(el("span", "err", msg));
  setStatus(msg, true);
}

// ── comments ───────────────────────────────────────
// Comment mode (the pointer button in the browser toolbar, web/cursor/commentOverlay.ts): click an element, and a
// bubble on it takes typed feedback (so does the form in a thread's panel, while its field has focus: a follow-up on
// the thread's element). While one is open, Shift, the talk button, always-listen and the form's mic dictate into it
// instead of starting a turn: a cursor-only turn (speech-to-text only: no reply, not remembered), whose final words
// are inserted at the form's caret. Its Send runs a turn that carries the text (shared/comment.ts) with the pointer
// on the element, on B; with Instant off it's added to the list instead (the bubble stays open, showing it).
const COMMENT_STATUS = "Comment open: type, or hold Shift / press the mic to talk into it.";
const DICTATION_TIMEOUT_MS = 30_000;
/** A comment bubble is open on the page. */
let commentOpen = false;
interface Dictation {
  turnId: string;
  released: boolean;
  capture?: CaptureHandle;
  audioStarted: Promise<void>;
  /** Words heard so far (stt.partial). */
  partial: string;
  timeout?: ReturnType<typeof setTimeout>;
}
let dictation: Dictation | null = null;
/** Dictation turns: their server messages never reach the conversation. */
const dictationIds = new Set<string>();

function publishComment(): void {
  const d = dictation;
  const listening = !!turn && !turn.finished && turn.tRelease === undefined;
  bridge.send({ type: "comment.state", state: { instant: settings.instant, recording: !!d && !d.released, transcribing: !!d?.released, partial: d && !d.released ? d.partial : "", listening } });
}

function resetPtt(): void {
  $("ptt").classList.remove("live");
  $("ptt").textContent = "Hold to talk";
}

/** Settings for a dictation: speech-to-text only. */
function dictationConfig(): RunConfig {
  return { ...config(), approach: "cursor-only", memory: false, threads: false, fillers: false, backgroundLongTasks: false };
}

/** Settings for a comment: element threads, answering in text only. */
function commentConfig(): RunConfig {
  return { ...config(), approach: "pipeline", threads: true, silent: true, fillers: false };
}

function startDictation(how: "manual" | "vad" | "button"): void {
  if (dictation) return;
  if (!sock.isOpen) return setStatus("Server not connected.", true);
  // The server runs one turn at a time: dictating talks over a reply, like a new turn would.
  const prev = turn;
  if (prev && !prev.finished) {
    if (prev.tRelease === undefined) return; // still recording a turn
    cancelTurn(prev, "interrupt");
  } else if (prev && audioOwner === "turn" && playback.isPlaying(performance.now())) {
    addTag(prev.view, "interrupted");
  }
  stopNotice();
  player?.reset();
  playback.reset();
  const turnId = crypto.randomUUID();
  const tPress = performance.now();
  const d: Dictation = { turnId, released: false, audioStarted: Promise.resolve(), partial: "" };
  dictation = d;
  dictationIds.add(turnId);
  sock.send({ type: "turn.start", turnId, config: dictationConfig(), tPress });
  $("ptt").classList.add("live");
  $("ptt").textContent = "Dictating…";
  setStatus(how === "vad" ? "Dictating into the comment… pause or press Shift to stop."
    : how === "button" ? "Dictating into the comment… press the mic again when done."
      : "Dictating into the comment… release to stop.");
  publishComment();
  refreshBusy();
  d.audioStarted = (async () => {
    try {
      d.capture = await startCapture({
        onFrame: (pcm) => { if (dictation === d && !d.released) sock.sendAudio(pcm); },
        preRollMs: how === "vad" ? VAD_PRE_ROLL_MS : 0,
      });
      const tAudioStart = await d.capture.tAudioStart;
      if (dictation === d) sock.send({ type: "turn.audioStart", turnId, tAudioStart });
    } catch (e) {
      endDictation(d, `Mic: ${(e as Error).message}`);
    }
  })();
}

/** Stop listening; the words are inserted when the transcript arrives. */
async function stopDictation(): Promise<void> {
  const d = dictation;
  if (!d || d.released) return;
  d.released = true;
  resetPtt();
  publishComment();
  await d.audioStarted;
  d.capture?.stop();
  if (dictation !== d) return;
  sock.send({ type: "turn.release", turnId: d.turnId, tRelease: performance.now() });
  setStatus("Transcribing…");
  d.timeout = setTimeout(() => endDictation(d, "No transcript from the server (timed out)."), DICTATION_TIMEOUT_MS);
}

/** Transcribed, failed or dropped: forget it. `cancel`: tell the server (it's still running). */
function endDictation(d: Dictation, error?: string, cancel = !!error): void {
  if (dictation !== d) return;
  dictation = null;
  clearTimeout(d.timeout);
  d.capture?.stop();
  if (cancel) sock.send({ type: "turn.cancel", turnId: d.turnId });
  if (meterTurn) {
    meterTurn = false;
    listen?.disarm();
  }
  resetPtt();
  publishComment();
  refreshBusy();
  if (error) setStatus(error, true);
  else if (!isRecording() && !turnBusy()) setStatus(commentOpen ? COMMENT_STATUS : readyStatus());
}

function onDictationMsg(msg: ServerMsg): void {
  const d = dictation;
  if (!d || !("turnId" in msg) || msg.turnId !== d.turnId) return; // one we already dropped
  if (msg.type === "stt.partial") {
    d.partial = msg.text;
    publishComment();
  } else if (msg.type === "stt.final") {
    if (msg.text.trim()) bridge.send({ type: "comment.insert", text: msg.text });
    endDictation(d);
  } else if (msg.type === "error") {
    endDictation(d, `${msg.source}: ${msg.message}`);
  } else if (msg.type === "turn.done") {
    endDictation(d, msg.run.error ? `Dictation: ${msg.run.error}` : undefined, false);
  }
}

/** The bubble's Send: run the comment as a turn now, or add it to the list (Instant off, or now isn't a good time). */
function sendComment(text: string, sample: CursorSample): void {
  if (dictation) endDictation(dictation, undefined, true);
  const turnId = crypto.randomUUID();
  // The pointer rests on the clicked element for the whole synthetic utterance (shared/comment.ts).
  const tRelease = performance.now();
  const tPress = tRelease - typedSpanMs(text);
  const samples: CursorSample[] = [];
  for (let t = tPress; t <= tRelease; t += BATCH_MS) samples.push({ ...sample, t, details: samples.length ? undefined : sample.details });
  const msgs: TurnMsg[] = [
    { type: "turn.start", turnId, config: commentConfig(), tPress, text, ...(pageUrl ? { pageUrl: normalizePageUrl(pageUrl) } : {}) },
    { type: "turn.audioStart", turnId, tAudioStart: tPress },
    { type: "cursor.samples", turnId, samples },
    { type: "turn.context", turnId, clicks: [], preselected: null, highlights: [] },
    { type: "turn.release", turnId, tRelease },
  ];
  const view = addTurnView(turnId);
  view.root.classList.add("comment");
  const q: Queued = { turnId, rec: msgs.map((msg) => ({ msg })), view, comment: text, at: Date.now() };
  const later = !settings.instant ? "" : !player ? "Audio isn't enabled" : !sock.isOpen ? "Server not connected" : isRecording() ? "You're talking" : sending ? "The list is being sent" : "";
  if (!settings.instant || later) {
    queue.push(q);
    showQueued(q);
    publishQueue();
    setStatus(later ? `${later}: added the comment to the list. ${queuedText()}` : `Added to the list. ${queuedText()}`);
    return;
  }
  if (turn && !turn.finished) cancelTurn(turn, "interrupt");
  void replay(q);
}

bridge.onComment?.((a) => {
  if (!isPageCommentAction(a)) return;
  if (a.type === "comment.draft") {
    commentOpen = a.open;
    if (!a.open && dictation) endDictation(dictation, undefined, true);
    if (!isRecording() && !turnBusy() && !noticeJobId) setStatus(commentOpen ? COMMENT_STATUS : readyStatus());
    publishComment();
  } else if (a.type === "comment.record") {
    if (!a.on) void stopDictation();
    else if (!player) setStatus("Click “Enable mic & audio” first.", true);
    else startDictation("button");
  } else {
    sendComment(a.text, a.sample); // the bubble says when it closes (with Instant off it stays open for more)
  }
});

// ── queued feedback ────────────────────────────────
// Instant off (the lightning button right of the address bar): a turn is recorded (audio, pointer, clicks and
// highlights, the page) instead of sent. Send (the arrow with the count) replays the queue in order, one turn after
// the other, each with the sidebar's settings at that moment. Talking over a sent turn or Esc stops the rest.
// With an on-device Speech model, each voice item is transcribed as soon as it's queued (free; POST
// /api/stt/transcribe): its text shows in the chat and on its marker, and its element comes from the words.
// Sending still replays the recording, so the turn is transcribed again with the settings then.
interface Queued {
  turnId: string;
  rec: Recorded[];
  view: TurnView;
  /** A comment's text (it has no audio; it's sent on B). */
  comment?: string;
  /** Its element on the page (queuedAnchor), once computed; null when it points at nothing. */
  anchor?: ThreadAnchor | null;
  /** When it was queued (epoch ms). */
  at?: number;
  /** The on-device transcript, made when it was queued ("" = no speech heard). */
  transcript?: { text: string; words: Word[] };
  /** Being transcribed on-device. */
  transcribing?: boolean;
}
const queue: Queued[] = [];
let sending = false;

function publishQueue(): void {
  shell?.queue?.publish({ instant: settings.instant, count: queue.length, sending });
  publishComment(); // the bubble's button: Send or Add to list
  threadsChanged(); // the queue's markers on the page
}
const queuedThreadId = (q: Queued) => `queued:${q.turnId}`;
/** The queue as threads for the page overlay (only items with an element). */
function queuedThreads(): ThreadInfo[] {
  return groupQueued(queue.flatMap((q) => {
    if (q.anchor === undefined) q.anchor = queuedAnchor(q.rec);
    if (!q.anchor) return [];
    const text = q.comment ?? (q.transcript?.text ? `“${q.transcript.text}”`
      : `Voice feedback, ${(recordedMs(q.rec) / 1000).toFixed(1)} s ${q.transcribing ? "(transcribing…)" : q.transcript ? "(no speech heard)" : "(transcribed when it's sent)"}`);
    return [{ turnId: q.turnId, anchor: q.anchor, text, at: q.at ?? Date.now() }];
  }));
}
const queuedText = () => `${queue.length} queued; send ${queue.length === 1 ? "it" : "them"} with the arrow next to the address bar.`;

/** A recorded turn was released: keep it, and show it as queued until it's sent. */
function enqueue(t: Turn): void {
  const rec = t.rec!;
  t.rec = undefined; // ended locally: nothing to cancel on the server
  cancelled.add(t.turnId); // not routed while queued
  endTurn(t);
  const q: Queued = { turnId: t.turnId, rec, view: t.view, at: Date.now() };
  queue.push(q);
  showQueued(q);
  publishQueue();
  setStatus(`Queued. ${queuedText()}`);
  transcribeQueued(q);
}

/** With an on-device Speech model: transcribe a queued voice item now, and re-anchor it on the words. */
function transcribeQueued(q: Queued): void {
  if (q.comment !== undefined || q.transcript || q.transcribing || !isLocalStt(settings.sttModel)) return;
  const pcm = recordedPcm(q.rec);
  if (!pcm.length) return;
  q.transcribing = true;
  showQueued(q);
  publishQueue();
  const qs = new URLSearchParams({ model: settings.sttModel, language: settings.language });
  fetch(`/api/stt/transcribe?${qs}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: pcm.buffer })
    .then(async (r) => {
      const j = (await r.json()) as { text?: string; words?: Word[]; error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      return { text: (j.text ?? "").trim(), words: j.words ?? [] };
    })
    .then((t) => {
      q.transcript = t;
      if (t.words.length) q.anchor = queuedAnchor(q.rec, t.words, languagesFor(settings.language));
    })
    .catch((e) => console.warn("[queue] on-device transcription failed", e))
    .finally(() => {
      q.transcribing = false;
      if (!queue.includes(q)) return; // sent or removed meanwhile
      showQueued(q);
      publishQueue();
    });
}

function showQueued(q: Queued): void {
  const v = q.view;
  v.root.classList.add("queued");
  v.user.classList.remove("pending");
  const secs = `${(recordedMs(q.rec) / 1000).toFixed(1)} s`;
  v.user.textContent = q.comment !== undefined ? `Queued comment · “${q.comment}”`
    : q.transcript?.text ? `Queued feedback · “${q.transcript.text}”`
    : `Queued feedback · ${secs}${q.transcribing ? " · transcribing…" : q.transcript ? " · no speech heard" : ""}`;
  const remove = el("button", "link queued-remove", "Remove");
  remove.title = "Drop this feedback without sending it";
  remove.onclick = () => removeQueued(q);
  v.meta.replaceChildren(remove);
}

/** Drop a queued item without sending it (the chat's Remove, or Delete in its panel on the page). */
function removeQueued(q: Queued): void {
  const i = queue.indexOf(q);
  if (i < 0) return;
  queue.splice(i, 1);
  q.view.root.remove();
  views.delete(q.turnId);
  if (!messages.querySelector(".turn, .job, .job-marker")) $("empty").hidden = false;
  publishQueue();
  setStatus(queue.length ? queuedText() : readyStatus());
}

/** A queued turn was cancelled while still being recorded (Esc, a failed mic): forget it. */
function dropRecording(t: Turn): void {
  cancelled.add(t.turnId);
  endTurn(t);
  t.view.root.remove();
  views.delete(t.turnId);
  if (!messages.querySelector(".turn, .job, .job-marker")) $("empty").hidden = false;
}

function stopSending(): void {
  sending = false;
  publishQueue();
}

/** Send the queue in order, one turn at a time. */
async function sendQueue(): Promise<void> {
  if (sending || !queue.length) return;
  if (!player) return setStatus("Click “Enable mic & audio” first.", true);
  if (isRecording()) return setStatus("Finish talking first, then send the queue.", true);
  if (turn && !turn.finished) cancelTurn(turn, "interrupt");
  sending = true;
  publishQueue();
  while (sending && queue.length) {
    if (!sock.isOpen) {
      setStatus("Server not connected; the rest stay queued.", true);
      break;
    }
    const q = queue.shift()!;
    publishQueue();
    await replay(q);
  }
  sending = false;
  publishQueue();
}

/** Send one queued turn now, as if it had just been released, with the current settings. */
function replay(q: Queued): Promise<void> {
  stopNotice();
  player?.reset();
  playback.reset();
  const now = performance.now();
  const release = q.rec.find((r): r is { msg: Extract<TurnMsg, { type: "turn.release" }> } => "msg" in r && r.msg.type === "turn.release");
  const d = now - (release?.msg.tRelease ?? now);
  const start = q.rec.find((r) => "msg" in r && r.msg.type === "turn.start") as { msg: Extract<TurnMsg, { type: "turn.start" }> } | undefined;
  const audioStart = q.rec.find((r) => "msg" in r && r.msg.type === "turn.audioStart") as { msg: Extract<TurnMsg, { type: "turn.audioStart" }> } | undefined;

  // The queued bubble becomes the turn: moved to the end of the conversation.
  const comment = q.comment !== undefined;
  const v = q.view;
  v.root.classList.remove("queued");
  v.user.classList.add("pending");
  v.user.textContent = q.comment ?? "…";
  v.meta.replaceChildren();
  messages.append(v.root);
  views.set(q.turnId, v);
  cancelled.delete(q.turnId);

  const t: Turn = {
    out: { send: (msg) => sock.send(msg), sendAudio: (pcm) => sock.sendAudio(pcm) },
    turnId: q.turnId, tPress: (start?.msg.tPress ?? now) + d, tRelease: now,
    tAudioStart: audioStart && audioStart.msg.tAudioStart + d,
    auto: release?.msg.auto, audioStarted: Promise.resolve(), sentUpTo: Infinity, detailed: new Map(), view: v,
    voice: "", lineStart: 0, solver: "", segmentOpen: false, finished: false, pageDone: true, silent: comment,
  };
  const ended = new Promise<void>((resolve) => { t.onEnd = resolve; });
  turn = t;
  centralAsking = false;
  lastTargets = [];
  lastRests = [];
  drawOverlay();
  for (const r of q.rec) {
    if ("pcm" in r) { sock.sendAudio(r.pcm); continue; }
    const msg = shiftMsg(r.msg, d);
    sock.send((msg.type === "turn.start" ? { ...msg, config: comment ? commentConfig() : config() } : msg) as ClientMsg);
  }
  bridge.send({ type: "provisional", turnId: t.turnId });
  setStatus(queue.length ? `Thinking… (${queue.length} more queued)` : "Thinking…");
  refreshBusy();
  t.timeout = setTimeout(() => failTurn(t, "No reply from the server (timed out)."), TURN_TIMEOUT_MS);
  scrollDown();
  return ended;
}

shell?.queue?.onCmd((cmd) => {
  const c = cmd as { type?: string; on?: unknown };
  if (c.type === "instant") {
    settings.instant = c.on === true;
    saveSettings();
    publishQueue();
    if (!isRecording() && !turnBusy()) setStatus(settings.instant ? readyStatus() : "Instant feedback is off: what you say is queued until you send it.");
  } else if (c.type === "send") void sendQueue();
});
publishQueue();

const INTENT_STATUS: Record<RouteIntent, string> = {
  question: "Looking into your question…",
  task: "Working on it…",
  clarify: "Asking you a follow-up…",
  answer: "Answering…",
};

sock.on((msg: ServerMsg) => {
  if ("turnId" in msg && msg.turnId && dictationIds.has(msg.turnId)) return onDictationMsg(msg);
  // A thread's background runs trace with jobId = threadId: no job card will claim them, so don't buffer them.
  if ((msg.type === "llm.prompt" || msg.type === "llm.response") && msg.jobId && threads.has(msg.jobId)) return;
  if (msg.type === "llm.prompt") return addPrompt(msg);
  if (msg.type === "llm.response") return onResponse(msg);
  if (msg.type === "memory") { memory = msg.memory; return renderMemory(); }
  if (msg.type === "job") return upsertJob(msg.job);
  if (msg.type === "notice") return onNotice(msg);
  if (msg.type === "threads.snapshot") {
    threads.clear();
    for (const t of msg.threads) threads.set(t.threadId, t);
    return threadsChanged();
  }
  if (msg.type === "thread") { threads.set(msg.thread.threadId, msg.thread); return threadsChanged(); }
  if (msg.type === "thread.removed") { threads.delete(msg.threadId); return threadsChanged(); }
  if (msg.type === "thread.say") return onThreadSay(msg);
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
      renderChips(v, msg.targets, lastRests, t.tAudioStart);
      drawOverlay();
      break;
    case "decision":
      renderDecision(v, msg);
      t.intent = msg.intent;
      t.threadId = msg.threadId;
      orbChanged();
      bridge.send({ type: "provisional.clear", turnId: t.turnId });
      sendTurnBubble(t, false);
      setStatus(msg.background ? "Working on it in the background; you can keep talking." : INTENT_STATUS[msg.intent]);
      break;
    case "voice.text":
      // Ack, fillers and the answer all arrive here; the turn shows everything said, in order, the page bubble the
      // last line.
      if (msg.line) t.lineStart = t.voice.length;
      t.voice += msg.delta;
      v.bot.hidden = false;
      v.botText.data = stripVoiceCues(t.voice);
      sendTurnBubble(t, false);
      setStatus(t.silent ? "Answering in text…" : settings.alwaysListen ? "Speaking… talk to interrupt, Esc to stop." : "Speaking… (press to interrupt, Esc to stop)");
      break;
    case "solver.text": {
      t.solver += msg.delta;
      const d = detailOf(t.solver);
      if (d) { v.detail.hidden = false; v.detailPre.textContent = d; }
      if (!t.voice) setStatus("The solver is thinking…");
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
      const filled = !t.voice && !!run.voiceText; // no voice.text deltas came: the run has the reply
      if (filled) t.voice = run.voiceText;
      endTurn(t);
      if (t.auto && !hasSpokenWords(run.transcript)) {
        v.root.remove();
        views.delete(t.turnId);
        if (!messages.querySelector(".turn, .job, .job-marker")) $("empty").hidden = false;
        setStatus(readyStatus());
        break;
      }
      if (v.user.classList.contains("pending")) {
        v.user.classList.remove("pending");
        v.user.textContent = run.transcript || "(not transcribed)";
      }
      if (filled) { v.bot.hidden = false; v.botText.data = stripVoiceCues(run.voiceText); }
      renderMeta(v, run);
      renderCost(v, run, t.turnId);
      setStatus(run.error ? `Finished with an error: ${run.error}` : readyStatus(), !!run.error);
      break;
    }
  }
  scrollDown();
});

/** A reply is already on the way, so the meter waits longer before a cross counts as a barge-in. */
function replyInFlight(): boolean {
  return turnBusy() || !!noticeJobId || playback.isPlaying(performance.now());
}

function meterError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  setStatus(`Microphone meter unavailable: ${message}`, true);
}

listen = mountAlwaysListen({
  checkbox: $<HTMLInputElement>("always-listen"),
  canvas: $<HTMLCanvasElement>("meter"),
  caption: $("meter-hint"),
  hangInput: $<HTMLInputElement>("listen-hang"),
  hangRow: $("hang-row"),
  enabled: settings.alwaysListen,
  threshold: settings.listenThreshold,
  hangMs: settings.listenHangMs,
  turnInFlight: replyInFlight,
  onEnabled: (on) => {
    settings.alwaysListen = on;
    saveSettings();
    publishMic();
    if (on && !player) void enableAudio();
    else if (!isRecording() && !turnBusy() && !noticeJobId) setStatus(readyStatus());
  },
  onThreshold: (rms) => { settings.listenThreshold = rms; saveSettings(); publishMic(); },
  onHangMs: (ms) => { settings.listenHangMs = ms; saveSettings(); },
  onStart: () => {
    // Still holding a turn, or its release hasn't reached the server yet. Dropping this cross
    // (and re-arming only after a dip) keeps a noise spike from cancelling the utterance.
    if (isRecording() || (turn && !turn.finished && turn.tRelease !== undefined && !turn.pageDone)) {
      listen?.disarm();
      return;
    }
    meterTurn = true;
    press("vad");
    if (!isRecording()) { meterTurn = false; listen?.disarm(); }
  },
  onStop: (speechMs) => {
    if (!meterTurn) return;
    if (dictation && !dictation.released) {
      // Dictating into a comment: a bump with no words is dropped, anything else is transcribed into it.
      if (autoSpeechTooShort(speechMs) && !hasSpokenWords(dictation.partial)) endDictation(dictation, undefined, true);
      else void stopDictation();
      return;
    }
    const t = turn;
    meterTurn = false;
    if (t && autoSpeechTooShort(speechMs) && !heardWords(t)) {
      discardAutoTurn(t);
      return;
    }
    void release(true);
  },
  onTapError: meterError,
  onLevel: micLevel,
});

// The toolbar's mic mirrors the talk button (ready, red while a turn or dictation records) and the Always listen box.
// Holding it reaches us as an external push-to-talk (main relays it on "ptt", like Shift in the browser pane).
function publishMic(): void {
  const ptt = $<HTMLButtonElement>("ptt");
  shell?.mic?.publish({ ready: !ptt.disabled, always: settings.alwaysListen, live: ptt.classList.contains("live"), threshold: settings.listenThreshold });
}
let micLevelAt = 0;
/** ~20 levels a second is plenty for the toolbar's sparkline. */
function micLevel(rms: number): void {
  const now = performance.now();
  if (now - micLevelAt < 50) return;
  micLevelAt = now;
  shell?.mic?.level(rms);
}
if (shell?.mic) {
  new MutationObserver(publishMic).observe($("ptt"), { attributes: true, attributeFilter: ["class", "disabled"] });
  shell.mic.onCmd((cmd) => {
    const c = cmd as { type?: string; on?: unknown };
    if (c.type !== "always") return;
    const box = $<HTMLInputElement>("always-listen");
    if (box.checked === (c.on === true)) return publishMic();
    box.checked = c.on === true;
    box.dispatchEvent(new Event("change"));
  });
  publishMic();
}

// One Shift while the meter holds the turn sends it. Held Shift (when the meter is idle) is still
// push-to-talk, via bindPushToTalk on the bubble phase. Swallow this keydown so it doesn't also start a hold.
window.addEventListener("keydown", (e) => {
  if (!meterTurn || e.repeat || !isPttKey(e) || isTypingTarget(e.target)) return;
  e.preventDefault();
  e.stopPropagation();
  meterTurn = false;
  listen?.disarm();
  void release(true);
}, true);

bindPushToTalk({
  button: $("ptt"),
  onPress: () => {
    listen?.setManualHold(true);
    if (meterTurn) { meterTurn = false; $("ptt").textContent = "Hold to talk"; return; } // the hold takes over; release sends it
    press("manual");
  },
  onRelease: () => {
    listen?.setManualHold(false);
    listen?.disarm();
    if (isRecording()) void release();
  },
  external: shell?.onPtt && ((down, up) => shell.onPtt!((d) => {
    // Shift in the browser pane: one press sends a meter turn; a press while idle still holds to talk.
    if (d && meterTurn) {
      meterTurn = false;
      listen?.disarm();
      void release(true);
      return;
    }
    if (d) down(); else up();
  })),
});
$("stop").onclick = () => stopAll();

/** Same rule as ptt.ts: Esc in a text control belongs to the control. A checkbox does not. */
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.repeat || isTypingTarget(e.target)) return;
  stopAll();
});

// The app grants the mic and allows audio without a click: ready to talk right away (the button comes back if that fails).
// After `listen` exists, so a saved Always listen can attach the meter.
$("enable").hidden = true;
void enableAudio();

// Live timers on running job cards, and the Stop button once queued audio has drained.
setInterval(() => {
  for (const c of jobs.values()) if (c.info.state === "running") renderJob(c);
  refreshBusy();
}, TICK_MS);

function clearConversation(): void {
  queueMicrotask(renderSessionCost);
  messages.querySelectorAll(".turn:not(.queued), .job, .job-marker, .note").forEach((n) => n.remove());
  centralAsking = false;
  views.clear();
  for (const q of queue) views.set(q.turnId, q.view);
  calls.clear();
  pendingResponses.clear();
  for (const id of jobs.keys()) droppedJobs.add(id);
  jobs.clear();
  renderJobsPill();
  $("empty").hidden = queue.length > 0;
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
  // The server clears every thread too (and says so); don't wait for it.
  threads.clear();
  threadsChanged();
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
      if (turn && !turn.finished && !turn.rec) failTurn(turn, "Connection lost.");
      if (dictation) endDictation(dictation, "Connection lost.", false);
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

