// Adapter interfaces (ARCHITECTURE §4). Orchestrators depend only on these.
import type { Mark } from "../clock.ts";
import type { PointingTarget, Word } from "../../shared/protocol.ts";
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
export interface RealtimeSession {
  pushAudio(pcm24k: Buffer): void;
  /** Commit buffer, optionally add a context item, then response.create. */
  commitAndRespond(extraContext?: string): void;
  onAudio(cb: (pcm24k: Buffer) => void): void;
  onText(cb: (delta: string) => void): void;
  onToolCall(cb: (call: ToolCall) => void): void;
  /** Sends function_call_output, then response.create. */
  sendToolResult(callId: string, output: string): void;
  /** Resolves when the current response finishes. */
  responseDone(): Promise<void>;
  /** Accumulated usage from response.done events. */
  readonly usage: unknown;
  close(): void;
}
export interface OpenRealtimeOpts { mark: Mark; model: RealtimeModel; instructions: string; tools: ToolDef[]; voice?: string }
export type OpenRealtime = (opts: OpenRealtimeOpts) => Promise<RealtimeSession>;

export interface RouteWithHaikuOpts {
  mark: Mark; transcript: string; pointing: PointingTarget[]; mode: RouterMode;
  /** Text to speak right away (ack, or a direct answer in auto mode). */
  onSpokenDelta: (d: string) => void;
}
export type RouteWithHaiku = (opts: RouteWithHaikuOpts) => Promise<{ delegate: null | { question: string }; usage: unknown }>;

export interface SolveWithOpusOpts {
  mark: Mark; question: string; pointing: PointingTarget[]; fast: boolean;
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
      question: { type: "string", description: "The precise question, including what the user is pointing at." },
      pointing_context: { type: "string", description: "Which element(s) the user pointed at, if known." },
    },
    required: ["question"],
  },
};
