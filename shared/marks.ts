// Timing mark names (ARCHITECTURE §5). C = stamped on the client, S = on the server.
export const MARK_NAMES = [
  "press", // C
  "release", // C — t = 0 for every latency metric
  "stt.firstPartial", // S
  "stt.final", // S
  "pointing.resolved", // S
  "llm.request", // S
  "llm.firstToken", // S
  "llm.toolCall", // S
  "ack.ttsFirstByte", // S
  "ack.played", // C
  "opus.request", // S
  "opus.firstToken", // S
  "opus.spokenReady", // S
  "opus.done", // S
  "answer.ttsFirstByte", // S
  "answer.played", // C
  "turn.end", // S
] as const;

export type MarkName = (typeof MARK_NAMES)[number];

export const CLIENT_MARKS: ReadonlySet<MarkName> = new Set(["press", "release", "ack.played", "answer.played"]);

export function isMarkName(s: string): s is MarkName {
  return (MARK_NAMES as readonly string[]).includes(s);
}

/** Derived metrics in ms relative to `release` (ARCHITECTURE §5). */
export interface Metrics {
  ttfa: number | null;
  tta: number | null;
  stt: number | null;
  llmFirst: number | null;
  toolCall: number | null;
  opusFirst: number | null;
  opusSpoken: number | null;
  opusTotal: number | null;
  ttsFirst: number | null;
}

export const METRIC_NAMES = [
  "ttfa", "tta", "stt", "llmFirst", "toolCall", "opusFirst", "opusSpoken", "opusTotal", "ttsFirst",
] as const satisfies readonly (keyof Metrics)[];

/** Marks are absolute client-clock times (performance.now() ms). */
export function deriveMetrics(marks: Partial<Record<MarkName, number>>): Metrics {
  const r = marks.release;
  const rel = (n: MarkName): number | null => (r === undefined || marks[n] === undefined ? null : marks[n]! - r);
  const ackPlayed = rel("ack.played");
  const answerPlayed = rel("answer.played");
  const played = [ackPlayed, answerPlayed].filter((v): v is number => v !== null);
  const opusReq = marks["opus.request"];
  const opusDone = marks["opus.done"];
  const ttsBase = marks["opus.spokenReady"] ?? marks["llm.firstToken"];
  const ansTts = marks["answer.ttsFirstByte"];
  return {
    ttfa: played.length ? Math.min(...played) : null,
    tta: answerPlayed,
    stt: rel("stt.final"),
    llmFirst: rel("llm.firstToken"),
    toolCall: rel("llm.toolCall"),
    opusFirst: rel("opus.firstToken"),
    opusSpoken: rel("opus.spokenReady"),
    opusTotal: opusReq !== undefined && opusDone !== undefined ? opusDone - opusReq : null,
    ttsFirst: ansTts !== undefined && ttsBase !== undefined ? ansTts - ttsBase : null,
  };
}
