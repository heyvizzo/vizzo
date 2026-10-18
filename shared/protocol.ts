// Browser ↔ server protocol (ARCHITECTURE §3). One WebSocket at /ws.
// Binary frames carry PCM16 mono 24 kHz audio for the active turn; text frames are JSON.
import type { RunConfig } from "./config.ts";
import type { MarkName, Metrics } from "./marks.ts";
import type { ThreadInfo, ThreadSay } from "./threads.ts";

/**
 * Audio segments. "ack" = first thing the voice layer says; "filler" = progress lines while the solver works
 * (short tasks, chat mode); "answer" = the answer; "notice" = a background job's result, spoken
 * outside any turn (framed by `notice` messages, not `audio.segment`). Only ack/answer carry marks.
 */
export type Segment = "ack" | "filler" | "answer" | "notice";

/** What the voice layer decided the user wants (chat decision, PRD follow-up). */
export type Intent = "question" | "task";
/** clarify = asked the user a follow-up instead of guessing; answer = answered directly (trivial). */
export type RouteIntent = Intent | "clarify" | "answer";

export interface JobInfo {
  jobId: string;
  /** The turn that started it. */
  turnId: string;
  approach: import("./config.ts").Approach;
  intent: Intent;
  question: string;
  estimateS: number | null;
  /** The language the user spoke (the result is written and spoken in it). */
  language?: string;
  state: "running" | "done" | "failed";
  /** The solver's SPOKEN line, when done. */
  spoken?: string;
  /** The solver's full answer, when done. */
  detail?: string;
  error?: string;
  elapsedMs?: number;
  /** What the job cost (its the solver call, then + speaking the result once the notice has played). */
  costUsd?: number;
  costItems?: CostItem[];
}

/** Seconds from turn audio start. */
export interface Word { text: string; start: number; end: number }

export interface CursorSample {
  t: number; x: number; y: number; scrollX: number; scrollY: number;
  /** Stable CSS path of document.elementFromPoint at sample time. */
  elementPath: string | null;
  /** Closest [data-source] attribute, "file:line". */
  dataSource: string | null;
  /** The most specific meaningful element's own label: its short text (a card title, a th), data-label or accessible name. */
  label: string | null;
  /** Label of the enclosing labeled component when the element is more specific than it (e.g. the card around a title). */
  container?: string | null;
  /**
   * Design details of the element (selector, classes, bounds, computed styles, markup), like a design-feedback
   * annotation. The page attaches them when the pointer reaches a new element (and refreshes them now and then);
   * the chat makes sure a turn's first sample on each element carries them (web/cursor/details.ts).
   */
  details?: ElementDetails;
}

/** What the models are told about a pointed-at element, beyond its label (shared/elementDetails.ts formats it). */
export interface ElementDetails {
  /** Short selector: the parent's segment and the element's, with classes (`div.header-meta > span.muted`). */
  selector: string;
  /** Full path from body, with ids and classes (`body > div#app > main#main-content > … > span.muted`). */
  domPath: string;
  tag: string;
  classes: string[];
  /** Interesting attributes (id, data-testid, role, href, type, name, aria-label…). */
  attrs: Record<string, string>;
  /** Visible text, whitespace collapsed and capped. */
  text: string | null;
  /** Viewport px, rounded. */
  bounds: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  /** Computed styles: a fixed list of properties (display, size, spacing, colors, border, font…). */
  styles: Record<string, string>;
  /** outerHTML, capped. */
  html: string;
  /** React dev-mode component info (web/cursor/reactInfo.ts), when the page is a React dev build. */
  react?: ReactInfo;
}

export interface ReactInfo {
  /** Named components above the element, nearest first (`HeaderMeta`, `PageHeader`, `SchemaMigrations`…). */
  chain: string[];
  /** The nearest component's props, summarized (`role: "owner", ceiling: 200, onChange: ƒ`). */
  props?: string;
  /** Where the element's JSX was written, `file:line`. */
  source?: string;
  /** False when the line is the dev server's transformed module's (React 19), which can be off by a few lines. */
  sourceExact?: boolean;
  /** A production build: only components with an explicit displayName are named, and there's no source location. */
  production?: boolean;
}

/** An element on the page, described like a CursorSample (see web/cursor/dom.ts describeElement). */
export interface ElementRef {
  elementPath: string | null;
  dataSource: string | null;
  label: string | null;
  container?: string | null;
}
/** single = 1 click, double = 2, triple = 3, multi = 4 or more (rapid clicks on the same element). */
export type ClickKind = "single" | "double" | "triple" | "multi";
/**
 * A click event on the page during a turn: consecutive clicks on the same element, < CLICK_GROUP_MS apart
 * and within a few px, are one event (web/cursor/pageContext.ts). Times are client clock (performance.now()).
 */
export interface PageClick extends ElementRef {
  kind: ClickKind;
  count: number;
  /** First click (press). */
  t: number;
  /** Last click (release). */
  tEnd: number;
  /** Every click's press time, in order (length === count). */
  times: number[];
  /** Position of the first click (viewport px). */
  x: number;
  y: number;
  /** Where each click landed, in press order: one entry per click the recorder gave coords (absent in records made before coords existed). */
  coords?: ClickCoords[];
}
export interface Pt { x: number; y: number }
export interface Size { width: number; height: number }
/** A position: px from a box's top-left corner, and the same as % of the box's size (shared/clickCoords.ts). */
export interface ClickSpot { px: Pt; pct: Pt }
/** Where one click landed: inside the pressed element (container) and on the page. Sizes are those at the press. */
export interface ClickCoords {
  container: { size: Size; at: ClickSpot };
  page: { size: Size; at: ClickSpot };
}
/** Text that was already highlighted when the recording started (t = the press time). */
export interface PageSelection extends ElementRef { t: number; text: string }
/** One highlight made during the recording (a finished drag / double / triple click / shift-select). */
export interface PageHighlight extends ElementRef {
  text: string;
  /** How it was made: dragging, double-clicking a word, triple-clicking a line/paragraph, shift-click or shift+arrows. */
  via?: "drag" | "double-click" | "triple-click" | "multi-click" | "shift-click" | "keyboard";
  /** When the gesture started (press) and when it finished (release / last key). Client clock. */
  tStart: number;
  t: number;
}

/** Which model call a prompt belongs to. */
export type PromptTarget = "router" | "fillers" | "solver";
/** One block of fixed instructions/context (system prompt). `cached`: marked for prompt caching. */
export interface PromptPart { label: string; text: string; cached?: boolean }
export interface PromptMessage { role: "user" | "assistant" | "system"; text: string; /** e.g. "earlier turn", "this turn", "audio" */ label?: string }
/** Exactly what was sent to a model (debug view on the Chat page). */
export interface LlmPrompt {
  target: PromptTarget;
  model: string;
  system: PromptPart[];
  messages: PromptMessage[];
  tools?: string[];
  toolChoice?: string;
  /** Other request settings worth seeing (effort, max_tokens, betas…). */
  settings?: Record<string, unknown>;
}

/** What a model call returned, raw (debug view). One per model call. */
export interface LlmResponse {
  target: PromptTarget;
  model?: string;
  /** Optional label for the response (shown in the debug view). */
  label?: string;
  stopReason?: string | null;
  usage?: unknown;
  /** From sending the request to the final message / response.done. */
  durationMs?: number;
  /** The final message / response.done payload as received. */
  raw?: unknown;
  error?: string;
  /** What this call cost, from its usage and the prices in docs/API-NOTES.md (0 when billed to the subscription). */
  costUsd?: number;
  /** "subscription": routed through `claude -p` (Claude Code login), not billed per call. */
  billing?: "api" | "subscription";
  /** Subscription calls: what the call would have cost at API prices. */
  savedUsd?: number;
}

/** One line of a turn's (or background job's) cost. */
/**
 * Memory in use, in bytes: each process's physical footprint (Activity Monitor's Memory column; it includes GPU memory,
 * which MLX models such as Parakeet use), or its resident size where the footprint can't be read.
 */
export interface MemorySnapshot {
  /** The whole app server: its Node process and every process it started (harnesses, warm agents, on-device speech models). */
  totalBytes: number;
  /** Of the total: the on-device speech models' helper processes (TTS and STT). */
  speechBytes?: number;
  /** The server's own Node process. */
  serverBytes: number;
  /**
   * Each thread's own harness process and its children, by threadId. Absent: no live process of its own (none open
   * yet or evicted, grok between requests, codex/opencode: one shared server, counted in the total only).
   */
  threads: Record<string, number>;
}

/** An on-device speech engine's helper process (GET /api/speech/engines; the Settings page shows it). */
export interface EngineState {
  kind: "tts" | "stt";
  /** The engine id ("parakeet", "kokoro"…). */
  engine: string;
  label: string;
  state: "loading" | "ready" | "error";
  error?: string;
  /** Spawn to ready (model loaded and warmed), ms. */
  loadMs?: number;
  /** Its process and children, as MemorySnapshot counts them. */
  ramBytes?: number;
}

/** Whether an on-device engine's models are on this Mac (server/speechInstall.ts), for Settings' Install buttons. */
export interface InstallState {
  kind: "tts" | "stt";
  engine: string;
  /** Part of macOS: nothing to install or remove. */
  builtin?: boolean;
  installed: boolean;
  /** "queued": waiting for another install to finish. "error": the last install failed (`error`). */
  state: "idle" | "queued" | "installing" | "error";
  /** While installing: the script's current step ("Downloading kokoro-v1.0.onnx"). */
  phase?: string;
  /** While downloading: how far, 0–1 (what came in against the usual size). Unset for the steps that can't be measured
   *  (setting up Python, compiling): the bar shows busy. */
  progress?: number;
  /** While downloading: received so far, of about how much. */
  receivedBytes?: number;
  totalBytes?: number;
  /** About how much an install downloads (models, plus the Python env if it isn't there yet). */
  downloadBytes?: number;
  /** Installed: the models' size on disk. */
  diskBytes?: number;
  error?: string;
  /** Voices being downloaded (or that failed to) for an installed engine (Piper), picked in Settings. */
  voices?: { voice: string; state: "queued" | "installing" | "error"; progress?: number; error?: string }[];
}

export interface CostItem {
  label: string;
  /** Billed cost (0 for calls routed through the subscription). */
  usd: number;
  /** Subscription calls / on-device speech: the API-price cost that wasn't billed. */
  savedUsd?: number;
  /** Where the saving came from: Claude through the claude -p subscription, or on-device macOS TTS (vs ElevenLabs). */
  savedVia?: "subscription" | "on-device";
  /** e.g. "ack 34 · filler 41 · answer 180 chars" */
  detail?: string;
  /** On a thread's items: the turn routed to it that spent this (also in that turn's own record). */
  turnId?: string;
}

/** Everything the user did on the page during a turn (ClientMsg turn.context). */
export interface PageEvents {
  clicks: PageClick[];
  /** Already highlighted when the recording started. */
  preselected: PageSelection | null;
  /** Highlights made during the recording, in order. */
  highlights: PageHighlight[];
}

/**
 * Where the cursor rested on one element (≥ 250 ms) while the user spoke, numbered @1, @2… in time order.
 * A language-agnostic pointing hint (shared/pointing.ts computeRests).
 */
export interface CursorRest {
  ref: number;
  /** Client clock. */
  tStart: number;
  tEnd: number;
  sample: CursorSample;
  /** Word being said during the rest (index into words), if any. */
  wordIndex: number | null;
  /** The cursor stayed on this element for (almost) the whole utterance. */
  whole: boolean;
}

export interface PointingTarget {
  word: string;
  wordStart: number;
  algorithm: string;
  sample: CursorSample | null;
  /** Reference number of this pointing word in the turn (1, 2, … in speech order; the same for every algorithm). */
  ref?: number;
  /** Index of the word in the turn's words[]. */
  wordIndex?: number;
}

// ── client → server ──────────────────────────────
export type ClientMsg =
  | { type: "hello"; clientNow: number }
  | { type: "ping"; id: number; clientNow: number }
  /** Result of clock sync, so the server can convert its marks to client time (offset = serverNow − clientNow). */
  | { type: "clock.sync"; rttMs: number; offsetMs: number }
  /**
   * pageUrl: the browser page the turn was recorded on (a queued turn sent later); otherwise the pane's current page.
   * text: a typed comment (shared/comment.ts): the turn's words, instead of transcribing audio.
   */
  | { type: "turn.start"; turnId: string; config: RunConfig; tPress: number; fixtureId?: string; pageUrl?: string; text?: string }
  | { type: "cursor.samples"; turnId: string; samples: CursorSample[] }
  /** tAudioStart: client time of the first captured audio sample (ARCHITECTURE §6). */
  | { type: "turn.audioStart"; turnId: string; tAudioStart: number }
  /** What the user clicked and highlighted on the page during the turn. Sent right before turn.release. */
  | ({ type: "turn.context"; turnId: string } & PageEvents)
  | { type: "turn.release"; turnId: string; tRelease: number; /** Always-listen ended the turn. Wordless clips are not sent on to the models. */ auto?: boolean }
  | { type: "audio.played"; turnId: string; segment: Segment; tPlayed: number }
  /** reason "interrupt": the user started talking over the reply; "stop": the user stopped it (Esc). */
  | { type: "turn.cancel"; turnId: string; reason?: "interrupt" | "stop" }
  /** Stop any background-job notice that's being spoken. */
  | { type: "speech.stop" }
  /** Debug: while on (and no turn is active), the server echoes binary audio frames back. */
  | { type: "echo"; on: boolean }
  /** Chat mode: forget the conversation. */
  | { type: "conversation.reset" }
  /** Element threads: delete one (stops its run, closes its harness session, removes it; edits stay in the code). */
  | { type: "thread.delete"; threadId: string }
  /** Element threads: the user opened a thread's panel (it becomes the focused thread; its result counts as told). */
  | { type: "thread.focus"; threadId: string };

// ── server → client ──────────────────────────────
export type ServerMsg =
  | { type: "pong"; id: number; clientNow: number; serverNow: number }
  | { type: "mark"; turnId: string; name: MarkName; serverNow: number; meta?: Record<string, unknown> }
  | { type: "stt.partial"; turnId: string; text: string }
  /** language: what Scribe detected (ISO code, e.g. "en", "ro"), when known. */
  | { type: "stt.final"; turnId: string; text: string; words: Word[]; language?: string }
  | { type: "pointing.resolved"; turnId: string; targets: PointingTarget[]; rests?: CursorRest[] }
  /** line: the delta starts a new spoken line (a filler, the answer after the ack); the page bubble shows the last. */
  | { type: "voice.text"; turnId: string; delta: string; line?: true }
  | { type: "solver.text"; turnId: string; delta: string }
  | { type: "audio.segment"; turnId: string; segment: Segment; state: "start" | "end" }
  | { type: "turn.done"; turnId: string; run: RunRecord }
  /** The voice layer's decision for this turn, as soon as it's known. background: the solver runs as a job. */
  | { type: "decision"; turnId: string; intent: RouteIntent; estimateS: number | null; background: boolean;
      /** Element threads: the thread this turn was routed to (new or existing); absent = the central conversation. */
      threadId?: string }
  /** A model call's exact prompt. jobId: sent by a background job (after its turn ended). */
  | { type: "llm.prompt"; turnId: string; jobId?: string; callId: string; prompt: LlmPrompt }
  /** The raw result of the call with the same callId. */
  | { type: "llm.response"; turnId: string; jobId?: string; callId: string; response: LlmResponse }
  /** Background job lifecycle (chat mode, long tasks). Not tied to the active turn. */
  | { type: "job"; job: JobInfo }
  /** Frames a spoken job result: binary audio between start and end belongs to it (sent only when no turn is active). */
  | { type: "notice"; jobId: string; state: "start" | "end" }
  /** Element threads: every thread (sent on connect, so a reloaded sidebar or page gets its markers back). */
  | { type: "threads.snapshot"; threads: ThreadInfo[] }
  /** Element threads: a thread was created or changed (full record). */
  | { type: "thread"; thread: ThreadInfo }
  | { type: "thread.removed"; threadId: string }
  /** Element threads: frames a line spoken outside a turn (a result, reminder or central line); audio between start and end belongs to it. */
  | { type: "thread.say"; say: ThreadSay; state: "start" | "end" }
  /** RAM in use, sampled every few seconds while a page is connected (server/memory.ts). */
  | { type: "memory"; memory: MemorySnapshot }
  | { type: "error"; turnId?: string; source: string; message: string };

export interface Usage {
  anthropic?: unknown;
  elevenChars?: number;
  /** Characters spoken by on-device TTS (macOS): not billed. */
  localTtsChars?: number;
  /** Characters spoken by OpenAI tts-1. */
  openaiTtsChars?: number;
  /** Characters spoken by Fish Audio Drama 3. */
  fishTtsChars?: number;
  /** ElevenLabs characters per spoken segment, in order (for the cost breakdown). */
  elevenSegments?: { label: string; chars: number }[];
  scribeSeconds?: number;
  /** Audio seconds sent to an OpenRouter STT model (batch), and which model. */
  openRouterSttSeconds?: number;
  openRouterSttModel?: string;
  /** Audio seconds transcribed by an on-device STT model: not billed (shown as saved vs Scribe). */
  localSttSeconds?: number;
}

export interface RunRecord {
  runId: string;
  turnId: string;
  approach: RunConfig["approach"];
  config: RunConfig;
  fixtureId?: string;
  /** Absolute client-clock times (performance.now() ms). */
  marks: Partial<Record<MarkName, number>>;
  /** ms relative to release. Server fills what it can; the client recomputes after audio.played. */
  metrics: Metrics;
  transcript: string;
  pointing: PointingTarget[];
  voiceText: string;
  solverText: string;
  usage: Usage;
  costUsd: number;
  /** costUsd itemized: each model call kind, TTS and STT. */
  costItems?: CostItem[];
  clock: { rttMs: number; offsetMs: number };
  markMeta?: Partial<Record<MarkName, Record<string, unknown>>>;
  error?: string;
}

export function parseClientMsg(raw: string): ClientMsg | null {
  try {
    const m = JSON.parse(raw) as { type?: unknown };
    return typeof m?.type === "string" ? (m as ClientMsg) : null;
  } catch {
    return null;
  }
}
