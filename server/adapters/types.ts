// Adapter interfaces (ARCHITECTURE §4). Orchestrators depend only on these.
import type { Mark } from "../clock.ts";
import type { ChatTurn } from "../conversation.ts";
import type { Intent, PointingTarget, RouteIntent, Word } from "../../shared/protocol.ts";
import type { RealtimeModel, RouterMode, TtsModel } from "../../shared/config.ts";

export type { Mark };

export interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }

export interface SttStream {
  pushAudio(pcm24k: Buffer): void;
  /** Push-to-talk release. */
  commit(): void;
  onPartial(cb: (text: string) => void): void;
  /** Resolves on committed_transcript_with_timestamps (3 s fallback to plain committed_transcript, empty words). */
  final(): Promise<{ text: string; words: Word[] }>;
  /** Idempotent. Rejects a still-pending final(). */
  close(): void;
  /** Audio seconds sent to the vendor so far, for cost. */
  readonly seconds: number;
}
export interface OpenScribeOpts { mark: Mark; keyterms?: string[] }
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
export interface OpenTtsOpts { mark: Mark; voiceId: string; model: TtsModel; segment: "ack" | "answer" }
export type OpenTts = (opts: OpenTtsOpts) => Promise<TtsStream>;

export interface ToolCall { callId: string; name: string; args: unknown }
/** OpenAI Realtime usage summed over every `response.done` in the session (API-NOTES §OpenAI). */
export interface RealtimeUsageTotals {
  inputTokens: number; outputTokens: number;
  inputText: number; inputAudio: number;
  /** Cached input tokens (subset of inputText / inputAudio). */
  cachedText: number; cachedAudio: number; cached: number;
  outputText: number; outputAudio: number;
}
export interface RealtimeUsage {
  /** Raw `response.usage` objects, one per completed response, in order. */
  responses: unknown[];
  totals: RealtimeUsageTotals;
}
/**
 * One pre-warmed session, REUSED across turns (ARCHITECTURE §7). Callbacks persist across turns;
 * call `beginTurn()` + `setMark()` at the start of each turn.
 */
export interface RealtimeSession {
  /**
   * Start of a turn: sends input_audio_buffer.clear and resets per-turn mark state. Responses still in flight
   * (e.g. one cancelled by an interruption) become stale: their audio, text and tool calls are dropped.
   */
  beginTurn(): void;
  /** Swap the mark function (per-turn marks on a reused session). */
  setMark(mark: Mark): void;
  pushAudio(pcm24k: Buffer): void;
  /** Commit buffer, optionally add a context item, then response.create. */
  commitAndRespond(extraContext?: string): void;
  onAudio(cb: (pcm24k: Buffer) => void): void;
  onText(cb: (delta: string) => void): void;
  onToolCall(cb: (call: ToolCall) => void): void;
  /** Vendor `error` events and socket failures. */
  onError(cb: (err: Error) => void): void;
  /**
   * Sends function_call_output, then response.create (deferred until the active response is done).
   * `respond: false` only records the output (background jobs, interrupted turns): no new response.
   */
  sendToolResult(callId: string, output: string, opts?: { respond?: boolean }): void;
  /**
   * Speak `text` in a response of its own, resolving at that response's response.done (rejects on error/close).
   * "filler": out-of-band (`conversation: "none"`, tool_choice none), the model says the text verbatim and it
   * stays out of the conversation. "notice": an in-conversation note + response (tool_choice none), so the
   * model remembers telling the user. Serialized with other responses like any response.create.
   */
  speak(text: string, kind: "filler" | "notice"): Promise<void>;
  /** response.cancel the active response (if any) and drop a deferred response.create. Keeps the session usable. */
  cancelResponse(): void;
  /**
   * Resolves when no ack/answer response is active or deferred; immediately if none is outstanding.
   * filler/notice responses and stale ones (from before the last beginTurn) don't count.
   */
  responseDone(): Promise<void>;
  /** Segment of the latest response: "ack" (turn's first), "answer" (after sendToolResult), "filler"/"notice" (speak). */
  readonly currentSegment: "ack" | "filler" | "answer" | "notice";
  /** Accumulated usage from response.done events. */
  readonly usage: RealtimeUsage;
  close(): void;
}
export interface OpenRealtimeOpts { mark: Mark; model: RealtimeModel; instructions: string; tools: ToolDef[]; voice?: string }
export type OpenRealtime = (opts: OpenRealtimeOpts) => Promise<RealtimeSession>;

export interface RouteWithHaikuOpts {
  mark: Mark; transcript: string; pointing: PointingTarget[]; mode: RouterMode;
  /** Chat mode: earlier turns, oldest first. */
  history?: ChatTurn[];
  /** Clicks / highlighted text from the turn, preformatted (shared/pointing.ts formatPageContext). */
  pageContext?: string;
  /** Long-task threshold in seconds when it differs from the prompt's default (RunConfig.longTaskSeconds). */
  longTaskSeconds?: number;
  /**
   * Fires once, as soon as the router's `intent` (and `estimate_seconds`, if given) are parsed, i.e. before
   * `say` streams, so the caller knows whether the spoken text is an ack or the whole reply.
   */
  onDecision?: (d: RouteDecision) => void;
  /**
   * Text to speak right away (the router's `say` field). `kind`: "ack" when a delegation follows
   * (intent question/task), "answer" when the text is the whole reply (intent clarify/answer).
   */
  onSpokenDelta: (d: string, kind: "ack" | "answer") => void;
  /** Optional: fires once `say` is complete (its closing quote), so TTS can be flushed before Haiku finishes. */
  onSpokenEnd?: (kind: "ack" | "answer") => void;
}
export interface RouteDecision { intent: RouteIntent; estimateS: number | null }
export type RouteWithHaiku = (opts: RouteWithHaikuOpts) => Promise<{
  delegate: null | { question: string; intent: Intent; estimateS: number | null };
  decision: RouteDecision;
  usage: unknown;
}>;

/** Short spoken progress lines for the wait on a short task (Haiku, called in parallel with Opus). */
export type GenerateFillers = (opts: {
  transcript: string; question: string; intent: Intent; pointing: PointingTarget[];
}) => Promise<{ lines: string[]; usage: unknown }>;

export interface SolveWithOpusOpts {
  mark: Mark; question: string; pointing: PointingTarget[]; fast: boolean;
  /** Chat mode: earlier turns, oldest first. */
  history?: ChatTurn[];
  /** Clicks / highlighted text from the turn, preformatted (shared/pointing.ts formatPageContext). */
  pageContext?: string;
  /** "task": the user wants something changed (Opus describes the change; it can't edit files here). Default question. */
  intent?: Intent;
  /** Fires once the SPOKEN: line is complete. */
  onSpokenLine: (line: string) => void;
  /** Full answer stream. */
  onDelta: (d: string) => void;
}
export type SolveWithOpus = (opts: SolveWithOpusOpts) => Promise<{ text: string; usage: unknown }>;

/** The tool every voice layer uses for hard tasks (PRD §4). */
export const ASK_OPUS_TOOL: ToolDef = {
  name: "ask_opus",
  description: "Delegate a hard question about the user's app or codebase to a stronger model. Speak a short acknowledgment first.",
  parameters: {
    type: "object",
    properties: {
      intent: {
        type: "string", enum: ["question", "task"],
        description: "question = the user wants information or an explanation; task = the user wants something changed or done.",
      },
      estimated_seconds: {
        type: "integer",
        description: "Your estimate of how long the stronger model needs: ~5-15 for questions, 60-300 for changes or multi-step work.",
      },
      question: { type: "string", description: "The precise question or task, including what the user is pointing at." },
      pointing_context: { type: "string", description: "Which element(s) the user pointed at, if known." },
    },
    required: ["intent", "estimated_seconds", "question"],
  },
};
