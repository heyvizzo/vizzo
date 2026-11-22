import type { DrawingAnnotation } from "../../shared/annotations.ts";
// Adapter interfaces (ARCHITECTURE §4). Orchestrators depend only on these.
import type { Mark } from "../clock.ts";
import type { ChatTurn } from "../conversation.ts";
import type { Intent, LlmPrompt, LlmResponse, PointingTarget, RouteIntent, Word } from "../../shared/protocol.ts";
import type { LlmChoice, RouterMode, SttModel, TtsModel, TtsStyle } from "../../shared/config.ts";
import type { ThreadState } from "../../shared/threads.ts";
import type { AgentSpec, HarnessResult, SessionRef } from "./harnesses.ts";
import type { WriterExecution } from "../changes/writers.ts";

export type { Mark };


export interface SttStream {
  pushAudio(pcm24k: Buffer): void;
  /** Push-to-talk release. */
  commit(): void;
  onPartial(cb: (text: string) => void): void;
  /** Full turn after commit(), including automatic segments (3 s fallback to plain text, empty words if incomplete). */
  /** `language`: the language Scribe detected (as sent, e.g. "en" / "ron"), when given. */
  final(): Promise<{ text: string; words: Word[]; language?: string }>;
  /** Idempotent. Rejects a still-pending final(). */
  close(): void;
  /** Audio seconds sent to the vendor so far, for cost. */
  readonly seconds: number;
}
export interface OpenScribeOpts {
  mark: Mark; keyterms?: string[];
  /** Which speech-to-text engine to open (default: Scribe). */
  model?: SttModel;
  /** Pin the language (ISO 639-1, e.g. "en", "ro"); omitted = Scribe auto-detects. */
  language?: string;
  /** No pin: detect only among these (two or more), where the engine can (WhisperKit, Rumble); the others ignore it. */
  languages?: string[];
}
export type OpenScribe = (opts: OpenScribeOpts) => Promise<SttStream>;

export interface TtsStream {
  pushText(delta: string): void;
  /** End of utterance: force generation. */
  flush(): void;
  onAudio(cb: (pcm24k: Buffer) => void): void;
  done(): Promise<void>;
  close(): void;
  /** Characters sent, for cost. */
  readonly chars: number;
}
export interface OpenTtsOpts {
  mark: Mark; voiceId: string; model: TtsModel; segment: "ack" | "answer";
  /** Spoken language (en / ro) for on-device voices; a getter when it's only known later (pre-opened sockets). */
  language?: string | (() => string | undefined);
  /** Engine-specific voice (Piper voice name, Kokoro voice id, OpenAI voice); the engine's default when omitted. */
  voice?: string;
  /** Delivery style for engines that support it (Fish Audio Drama 3). */
  style?: TtsStyle;
}
export type OpenTts = (opts: OpenTtsOpts) => Promise<TtsStream>;

export interface RouteTurnOpts {
  annotation?: DrawingAnnotation;
  mark: Mark; transcript: string; pointing: PointingTarget[]; mode: RouterMode;
  /** Chat mode: earlier turns, oldest first. */
  history?: ChatTurn[];
  /** Clicks / highlighted text from the turn, preformatted (shared/pointing.ts formatPageContext). */
  pageContext?: string;
  /** The language the user spoke (e.g. "ro"): replies are written in it. Omitted = English. */
  language?: string;
  /** Long-task threshold in seconds when it differs from the prompt's default (RunConfig.longTaskSeconds). */
  longTaskSeconds?: number;
  /** The reply is spoken by Fish Audio Drama 3 (English): the `say` line may carry acting cues. */
  voiceCues?: boolean;
  /** Called with the exact prompt right before it's sent (debug view). */
  onPrompt?: (p: LlmPrompt) => void;
  /** Harness or API + model (RunConfig.llm's tier). Omitted: the Anthropic Messages API with the default model. */
  llm?: LlmChoice;
  /** Called with the raw result (or error) of that request (debug view). */
  onResponse?: (r: LlmResponse) => void;
  /**
   * Fires once, as soon as the router's `intent` (and `estimate_seconds`, if given) are parsed, i.e. before
   * `say` streams, so the caller knows whether the spoken text is an ack or the whole reply.
   */
  onDecision?: (d: RouteDecision) => void;
  /** The router's `language` field (the language of the user's words), as soon as it streams in: before `say`. */
  onLanguage?: (language: string) => void;
  /**
   * Text to speak right away (the router's `say` field). `kind`: "ack" when a delegation follows
   * (intent question/task), "answer" when the text is the whole reply (intent clarify/answer).
   */
  onSpokenDelta: (d: string, kind: "ack" | "answer") => void;
  /** Optional: fires once `say` is complete (its closing quote), so TTS can be flushed before the router finishes. */
  onSpokenEnd?: (kind: "ack" | "answer") => void;
  /**
   * Element threads (docs/PLAN-threads.md): the threads the router can send this turn to. Given (even empty) =
   * threads mode: the router also outputs `target` / `relation` / `tell`, and RouteDecision.target is set.
   */
  threads?: ThreadBrief[];
  /** Element threads: what the user is pointing at this turn ("the red button", from the anchor), if anything. */
  anchorLabel?: string;
  /** The user clicked the pointed element during a spoken turn: a marker is placed there unless they name another thread. */
  clicked?: boolean;
  /** Typed, with no speech: the marker stays on the click. */
  typed?: boolean;
  /** Typed in the main message box, with no pointer. It can refer to a listed thread. */
  chat?: boolean;
  /** Spoken with this task's panel open: the turn stays on that thread. */
  panel?: string;
}

/** What the router is told about one element thread. */
export interface ThreadBrief {
  threadId: string;
  title: string;
  state: ThreadState;
  summary: string;
  /** On the page the user is looking at now. */
  onCurrentPage: boolean;
  /** Its element is the one the user points at this turn (anchor match). */
  underCursor: boolean;
}

/**
 * Where a turn goes (threads mode). new: a new thread on the pointed element. thread: an existing thread; relation
 * followup = queued behind its current run, correction = restarts it. central: page-wide, no single element.
 */
export type RouteTarget =
  | { kind: "new" }
  | { kind: "thread"; threadId: string; relation: "followup" | "correction" }
  | { kind: "central" };

export interface RouteDecision {
  intent: RouteIntent; estimateS: number | null;
  /** Threads mode only. */
  target?: RouteTarget;
  /** Threads mode: "tell me about the red button" = speak this thread's latest result (no harness run). */
  tell?: string;
}
export type RouteTurn = (opts: RouteTurnOpts) => Promise<{
  delegate: null | { question: string; intent: Intent; estimateS: number | null };
  decision: RouteDecision;
  usage: unknown;
}>;

/**
 * Short spoken progress lines for the wait on a short task (the router, called in parallel with the solver), and the
 * cut-in: what's said instead when the answer arrives mid-line and the line is broken off ("Oh, wait, here it is.").
 */
export type GenerateFillers = (opts: {
  transcript: string; question: string; intent: Intent; pointing: PointingTarget[];
  /** The language the user spoke: lines are written in it. */
  language?: string;
  /** The lines are spoken by Fish Audio Drama 3 (English): one long sentence each, with stretched words. */
  voiceCues?: boolean;
  onPrompt?: (p: LlmPrompt) => void;
  /** Called with the raw result (or error) of that request (debug view). */
  onResponse?: (r: LlmResponse) => void;
  /** Harness or API + model (RunConfig.llm's tier). Omitted: the Anthropic Messages API with the default model. */
  llm?: LlmChoice;
}) => Promise<{ lines: string[]; cutIn?: string; usage: unknown }>;

export interface SolveTaskOpts {
  /** The immutable Vizzo execution, fixed before handing the request to its native harness. */
  execution?: WriterExecution;
  annotation?: DrawingAnnotation;
  mark: Mark; question: string; pointing: PointingTarget[]; fast: boolean;
  /**
   * The user's own words (the transcript with its pointing markers, or what they typed), when `question` is the
   * router's reading of them: the solver gets both, and the user's own decide.
   */
  original?: string;
  /** Chat mode: earlier turns, oldest first. */
  history?: ChatTurn[];
  /** Clicks / highlighted text from the turn, preformatted (shared/pointing.ts formatPageContext). */
  pageContext?: string;
  /** The language the user spoke (e.g. "ro"): replies are written in it. Omitted = English. */
  language?: string;
  /** The SPOKEN line is read by Fish Audio Drama 3 (English): it may carry acting cues. */
  voiceCues?: boolean;
  /** "task": the user wants something changed (the solver describes the change; it can't edit files here). Default question. */
  intent?: Intent;
  /** Called with the exact prompt right before it's sent (debug view). */
  onPrompt?: (p: LlmPrompt) => void;
  /** Harness or API + model (RunConfig.llm's tier). Omitted: the Anthropic Messages API with the default model. */
  llm?: LlmChoice;
  /** Called with the raw result (or error) of that request (debug view). */
  onResponse?: (r: LlmResponse) => void;
  /** Fires once the SPOKEN: line is complete. */
  onSpokenLine: (line: string) => void;
  /** Full answer stream. */
  onDelta: (d: string) => void;
  /** Aborted: the harness agent is killed and the call rejects (a background job the user stopped). */
  signal?: AbortSignal;
  /** The run is stopped after this long (RunConfig.taskTimeoutMinutes). Omitted: ROLE_TIMEOUT_MS.solver. */
  timeoutMs?: number;
}
export type SolveTask = (opts: SolveTaskOpts) => Promise<{ text: string; usage: unknown }>;

// ── Sessions: persistent harness sessions (docs/PLAN-threads.md, docs/ARCHITECTURE.md "Harness sessions") ──

/**
 * How a request reached its session. live: the session's process was waiting. new: the session's first request.
 * resumed: its process was gone and the harness's saved session was continued by id. forked: a new session started
 * with another's history (a long job off the central conversation). replayed: a new session that was given Vizzo's
 * own record of the history as text (nothing to resume natively, or the resume didn't take): the harness's
 * intermediate tool results are not in it.
 */
export type SessionMode = "live" | "new" | "resumed" | "forked" | "replayed";

/** What went to the session for one request, as sent (debug trace). */
export interface SessionDispatch {
  mode: SessionMode;
  /** The harness's own session id, when it is known as the message goes out (a new session's may only come after). */
  sessionId?: string;
  /** The message after the history, the notes and the attachment line were added. */
  message: string;
  /** Why the saved session wasn't continued natively (mode replayed after a resume or fork that didn't take). */
  fallback?: string;
}

/**
 * One harness session: the central conversation's, an element thread's or a long job's. Successive requests share
 * the harness's own context. What it runs with (harness, model, level, switches, prompt and saved instructions) is
 * fixed when it is opened: later changes in Settings apply to new sessions only.
 */
export interface HarnessThread {
  readonly id: string;
  /** The harness + model the session runs on (always set by openHarnessThread; test fakes may leave it out). */
  readonly choice?: LlmChoice;
  /** What its agents start with, fixed at its first request (absent before; test fakes leave it out). */
  readonly spec?: AgentSpec;
  readonly projectFolder?: string | null;
  /**
   * Send the next user message and stream the reply. Requests on one session are serialized (a second send waits).
   * Without a live process (first use, evicted, crashed) one is started on the harness's saved session; only when
   * there is none to continue is `replay()` sent first in the same message. `onDispatch`: called with the message
   * as it goes out.
   */
  send(user: string, onText: ((d: string) => void) | undefined, timeoutMs: number, annotations?: readonly DrawingAnnotation[], onDispatch?: (d: SessionDispatch) => void, execution?: WriterExecution): Promise<HarnessResult & {
    /** Project-relative paths of files the run edited (best effort from the harness's tool events). */
    filesTouched: string[];
    /** The history was replayed as text into a new session for this request (mode "replayed"). */
    reopened: boolean;
    /** How the request reached the session (absent from test fakes). */
    session?: { mode: SessionMode; id?: string; file?: string; fallback?: string };
  }>;
  /** The process its live session runs in alone (see WarmAgent.pid), for RAM per thread. Absent: none. */
  pid?(): number | undefined;
  /** Stop the in-flight request (its send() rejects with an AbortError-named error). The session stays, with its context. */
  abort(): void;
  /** The active request's native terminal event or process exit, including in-flight edit notifications. */
  readonly settled?: Promise<void>;
  /**
   * Stop the session's process for good (thread deleted, new conversation). The harness's saved session stays on
   * disk, so the user can still open it with the harness's own resume command.
   */
  close(): void;
  /** A process is attached right now. */
  readonly live: boolean;
  /** Release the live connection once idle, keeping the saved session for a terminal or the next send. */
  release?(): Promise<void>;
  /** The harness's own saved session, once it has one (what `claude --resume` and the like take). */
  session?(): SessionRef | undefined;
}

export interface OpenHarnessThreadOpts {
  /** Explicit null keeps the session in its empty project. */
  projectFolder?: string | null;
  role: "solver";
  choice: LlmChoice;
  /** Native session metadata may have changed (starting, first output, completion or fallback). */
  onSession?(): void;
  /** The history as plain text, prepended when a session starts with none of its own. "" = nothing yet. */
  replay: () => string;
  replayAnnotations?: () => DrawingAnnotation[];
  /**
   * What happened outside the session since it last heard (the conversation's other turns), prepended to a request
   * on a session that has its own history (live, resumed or forked). "" = nothing.
   */
  notes?: () => string;
  /** Start as a fork of this session's saved one when it has one (same harness); otherwise new, with `replay()`. */
  forkOf?: HarnessThread;
  /**
   * A session saved before the app last closed (server/threads/persist.ts): it keeps the spec it was opened with and
   * its first request resumes `ref` (or, without one, starts new with `replay()`).
   */
  restore?: { spec: AgentSpec; ref?: SessionRef };
}
/** Live processes are capped (MAX_LIVE_THREAD_SESSIONS): the least recently used idle one is stopped, and resumed when needed. */
export type OpenHarnessThread = (opts: OpenHarnessThreadOpts) => HarnessThread;

/** One request on an element thread: like SolveTaskOpts, but the history lives in the thread's session. */
export interface SolveInThreadOpts extends Omit<SolveTaskOpts, "history" | "fast" | "llm"> {
  thread: HarnessThread;
  /** How this request relates to the thread: the first one carries the full system framing. */
  kind: "request" | "followup" | "correction" | "reconcile" | "direct";
}
export type SolveInThread = (opts: SolveInThreadOpts) => Promise<{ text: string; usage: unknown; filesTouched: string[] }>;
