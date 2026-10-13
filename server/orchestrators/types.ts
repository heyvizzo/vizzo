import type { RunConfig } from "../../shared/config.ts";
import type { CursorSample, PageEvents, PointingTarget, ServerMsg, Usage } from "../../shared/protocol.ts";
import type { Mark } from "../clock.ts";
import type { GenerateFillers, OpenRealtime, OpenScribe, OpenTts, RouteWithHaiku, SolveWithOpus } from "../adapters/types.ts";

/**
 * Per-browser-connection cache (T7 addition). Lives as long as the Session's WebSocket; every entry's
 * `dispose` runs when the connection closes (or when the entry is replaced/deleted). Used to keep one
 * pre-warmed OpenAI Realtime session per connection and reuse it across turns (ARCHITECTURE §7).
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
  /** Clicks and highlighted text the client reported for this turn (turn.context). */
  pageEvents?: () => PageEvents;
  /** T7 addition: state that outlives the turn (one per browser connection). */
  connection: ConnectionCache;
  /** Connection-level output for background jobs (chat mode). Without it, long tasks run inline. */
  channel?: ConnectionChannel;
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
  opusText: string;
  usage: Usage;
  error?: string;
  /**
   * T7 addition. Realtime/hybrid label the model's first response "ack" on the wire because it is
   * only known after the audio has started whether a tool call follows. When no ask_opus call
   * happened, that audio WAS the answer (PRD §7: TTA = TTFA for easy questions), so the Session
   * renames the `ack.ttsFirstByte` / `ack.played` marks to `answer.*` in the RunRecord.
   */
  ackIsAnswer?: boolean;
}

export type Orchestrator = (ctx: TurnContext) => TurnHandlers;

/** Adapters an orchestrator uses. Injected so tests and `smoke:e2e --fake` can swap in fakes. */
export interface OrchestratorDeps {
  openScribe: OpenScribe;
  openRealtime: OpenRealtime;
  openTts: OpenTts;
  routeWithHaiku: RouteWithHaiku;
  solveWithOpus: SolveWithOpus;
  /** Progress lines for the wait on short tasks (chat mode). Optional: no fillers without it. */
  generateFillers?: GenerateFillers;
  /** ElevenLabs voice id (default: process.env.ELEVENLABS_VOICE_ID). */
  voiceId?: string;
  /** Overall per-turn timeout from turn.start (default 60 s). */
  turnTimeoutMs?: number;
  /** Hybrid: after the voice reply finishes, how long to still wait for a late Scribe final (default 2 s). */
  hybridLateWaitMs?: number;
}
