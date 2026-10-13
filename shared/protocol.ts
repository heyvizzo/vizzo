// Browser ↔ server protocol (ARCHITECTURE §3). One WebSocket at /ws.
// Binary frames carry PCM16 mono 24 kHz audio for the active turn; text frames are JSON.
import type { RunConfig } from "./config.ts";
import type { MarkName, Metrics } from "./marks.ts";

export type Segment = "ack" | "answer";

/** Seconds from turn audio start. */
export interface Word { text: string; start: number; end: number }

export interface CursorSample {
  t: number; x: number; y: number; scrollX: number; scrollY: number;
  /** Stable CSS path of document.elementFromPoint at sample time. */
  elementPath: string | null;
  /** Closest [data-source] attribute, "file:line". */
  dataSource: string | null;
  /** Closest [data-label] or accessible name. */
  label: string | null;
}

export interface PointingTarget { word: string; wordStart: number; algorithm: string; sample: CursorSample | null }

// ── client → server ──────────────────────────────
export type ClientMsg =
  | { type: "hello"; clientNow: number }
  | { type: "ping"; id: number; clientNow: number }
  /** Result of clock sync, so the server can convert its marks to client time (offset = serverNow − clientNow). */
  | { type: "clock.sync"; rttMs: number; offsetMs: number }
  | { type: "turn.start"; turnId: string; config: RunConfig; tPress: number; fixtureId?: string }
  | { type: "cursor.samples"; turnId: string; samples: CursorSample[] }
  /** tAudioStart: client time of the first captured audio sample (ARCHITECTURE §6). */
  | { type: "turn.audioStart"; turnId: string; tAudioStart: number }
  | { type: "turn.release"; turnId: string; tRelease: number }
  | { type: "audio.played"; turnId: string; segment: Segment; tPlayed: number }
  | { type: "turn.cancel"; turnId: string }
  /** Debug: while on (and no turn is active), the server echoes binary audio frames back. Used by /audio-test. */
  | { type: "echo"; on: boolean };

// ── server → client ──────────────────────────────
export type ServerMsg =
  | { type: "pong"; id: number; clientNow: number; serverNow: number }
  | { type: "mark"; turnId: string; name: MarkName; serverNow: number; meta?: Record<string, unknown> }
  | { type: "stt.partial"; turnId: string; text: string }
  | { type: "stt.final"; turnId: string; text: string; words: Word[] }
  | { type: "pointing.resolved"; turnId: string; targets: PointingTarget[] }
  | { type: "voice.text"; turnId: string; delta: string }
  | { type: "opus.text"; turnId: string; delta: string }
  | { type: "audio.segment"; turnId: string; segment: Segment; state: "start" | "end" }
  | { type: "turn.done"; turnId: string; run: RunRecord }
  | { type: "error"; turnId?: string; source: string; message: string };

export interface Usage {
  anthropic?: unknown;
  openai?: unknown;
  elevenChars?: number;
  scribeSeconds?: number;
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
  opusText: string;
  usage: Usage;
  costUsd: number;
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
