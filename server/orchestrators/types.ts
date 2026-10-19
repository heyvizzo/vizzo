import type { RunConfig } from "../../shared/config.ts";
import type { CursorSample, PageEvents, PointingTarget, ServerMsg, Usage } from "../../shared/protocol.ts";
import type { Mark } from "../clock.ts";
import type { GenerateFillers, OpenHarnessThread, OpenScribe, OpenTts, RouteTurn, SolveInThread, SolveTask } from "../adapters/types.ts";

/**
 * Per-browser-connection cache (T7 addition). Lives as long as the Session's WebSocket; every entry's
 * `dispose` runs when the connection closes (or when the entry is replaced/deleted).
 */
export interface ConnectionCache {
  get<T>(key: string): T | undefined;
  /** Replaces (and disposes) any previous entry under `key`. */
  set<T>(key: string, value: T, dispose?: (value: T) => void): void;
  /** Disposes and removes the entry, if any. */
  delete(key: string): void;
}

/**
 * Connection-level output, not tied to a turn (background jobs and their spoken notices).
 * Provided by the Session; absent in unit tests that don't need it.
 */
export interface ConnectionChannel {
  send(msg: ServerMsg): void;
  sendAudio(pcm24k: Buffer): void;
  /** Resolves once no turn is active (after a short grace period). */
  whenIdle(): Promise<void>;
  /** No turn is active right now. */
  isIdle(): boolean;
  /** Register how to stop the notice being spoken (null when it's over). Called on turn.start / speech.stop. */
  setNoticeAbort(abort: (() => void) | null): void;
}

/** What a Session gives an orchestrator for one turn. */
export interface TurnContext {
  turnId: string;
  config: RunConfig;
  mark: Mark;
  send: (msg: ServerMsg) => void;
  sendAudio: (pcm24k: Buffer) => void;
  /** Cursor samples received so far this turn (client clock). */
  cursorSamples: () => CursorSample[];
  /** Client time of the first captured audio sample, once known. */
  tAudioStart: () => number | undefined;
  /** The page the turn was recorded on, when the client sent one (queued feedback); else browserUrl() applies. */
  pageUrl?: () => string | null;
  /** A typed comment (turn.start `text`): the turn's words, with no audio to transcribe. */
  typedText?: string;
  /** The thread whose panel was open when the turn started: the turn goes to it, not where the router would send it. */
  pinnedThread?: string;
  /** Clicks and highlighted text the client reported for this turn (turn.context). */
  pageEvents?: () => PageEvents;
  /** T7 addition: state that outlives the turn (one per browser connection). */
  connection: ConnectionCache;
  /** Connection-level output for background jobs (chat mode). Without it, long tasks run inline. */
  channel?: ConnectionChannel;
  /**
   * True when always-listen ended this turn (the silence hang), not a held Shift or button.
   * Read at release: a clip with no words must not be sent to the models.
   */
  autoEndpoint?: () => boolean;
}

/** Handlers for one turn. Created on turn.start. */
export interface TurnHandlers {
  onAudio(pcm24k: Buffer): void;
  onRelease(): void;
  cancel(): void;
  /** Resolves when the turn is finished; returns what goes into the RunRecord. */
  done: Promise<TurnResult>;
}

export interface TurnResult {
  transcript: string;
  pointing: PointingTarget[];
  voiceText: string;
  solverText: string;
  usage: Usage;
  error?: string;
}

export type Orchestrator = (ctx: TurnContext) => TurnHandlers;

/** Adapters an orchestrator uses. Injected so tests and `smoke:e2e --fake` can swap in fakes. */
export interface OrchestratorDeps {
  openScribe: OpenScribe;
  openTts: OpenTts;
  routeTurn: RouteTurn;
  solveTask: SolveTask;
  /** Element threads: persistent harness sessions + a request in one. Optional: without them, no threads mode. */
  openThread?: OpenHarnessThread;
  solveInThread?: SolveInThread;
  /** Progress lines for the wait on short tasks (chat mode). Optional: no fillers without it. */
  generateFillers?: GenerateFillers;
  /** ElevenLabs voice id (default: process.env.ELEVENLABS_VOICE_ID). */
  voiceId?: string;
  /** Overall per-turn timeout from turn.start (default 60 s). */
  turnTimeoutMs?: number;
}
