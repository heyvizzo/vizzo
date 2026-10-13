export type Approach = "realtime" | "pipeline" | "hybrid" | "cursor-only";
export type RealtimeModel = "gpt-realtime-2.1" | "gpt-realtime-2.1-mini";
export type TtsModel = "eleven_v4_turbo" | "eleven_flash_v2_5";
export type RouterMode = "forced" | "auto";
/** Spoken language: "auto" lets Scribe detect it (en or ro expected); "en"/"ro" pin it. */
export type SpeechLanguage = "auto" | "en" | "ro";

export interface RunConfig {
  approach: Approach;
  realtimeModel: RealtimeModel;
  opusFast: boolean;
  routerMode: RouterMode;
  /** Approach C: max ms to wait for the Scribe commit after release. */
  hybridWaitMs: number;
  ttsModel: TtsModel;
  /** Open vendor sockets ahead of the turn so setup isn't counted. */
  prewarm: boolean;
  /** Pointing window offsets (ARCHITECTURE §6). */
  preMs: number;
  postMs: number;
  /** Chat mode: keep conversation history across turns (and approaches) on this connection. */
  memory: boolean;
  /** Speak short progress lines while waiting for Opus on short tasks. */
  fillers: boolean;
  /** Run long tasks (estimate > longTaskSeconds) as background jobs and announce the result later. */
  backgroundLongTasks: boolean;
  /** Estimate (seconds) above which a task counts as long. */
  longTaskSeconds: number;
  /** Speech language for Scribe and the pointing word lists (benchmarks stay pinned to "en"). */
  language: SpeechLanguage;
}

export const DEFAULT_CONFIG: RunConfig = {
  approach: "pipeline",
  realtimeModel: "gpt-realtime-2.1",
  opusFast: false,
  routerMode: "forced",
  hybridWaitMs: 400,
  ttsModel: "eleven_v4_turbo",
  prewarm: true,
  preMs: 300,
  postMs: 200,
  memory: false,
  fillers: false,
  backgroundLongTasks: false,
  longTaskSeconds: 20,
  language: "en",
};

export const MODELS = {
  haiku: "claude-haiku-5-5",
  opus: "claude-opus-5-5",
  scribe: "scribe_v2_realtime",
} as const;

/** Audio format used on every hop: PCM16 mono little-endian. */
export const SAMPLE_RATE = 24000;
