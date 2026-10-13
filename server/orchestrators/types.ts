import type { RunConfig } from "../../shared/config.ts";
import type { CursorSample, ServerMsg } from "../../shared/protocol.ts";
import type { Mark } from "../clock.ts";

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
  pointing: import("../../shared/protocol.ts").PointingTarget[];
  voiceText: string;
  opusText: string;
  usage: import("../../shared/protocol.ts").Usage;
  error?: string;
}

export type Orchestrator = (ctx: TurnContext) => TurnHandlers;
