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
  "solver.request", // S
  "solver.firstToken", // S
  "solver.spokenReady", // S
  "solver.done", // S
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
  solverFirst: number | null;
  solverSpoken: number | null;
  solverTotal: number | null;
  ttsFirst: number | null;
}

export const METRIC_NAMES = [
  "ttfa", "tta", "stt", "llmFirst", "toolCall", "solverFirst", "solverSpoken", "solverTotal", "ttsFirst",
] as const satisfies readonly (keyof Metrics)[];

/** Marks are absolute client-clock times (performance.now() ms). */
export function deriveMetrics(marks: Partial<Record<MarkName, number>>): Metrics {
  const r = marks.release;
  const rel = (n: MarkName): number | null => (r === undefined || marks[n] === undefined ? null : marks[n]! - r);
  const ackPlayed = rel("ack.played");
  const answerPlayed = rel("answer.played");
  const played = [ackPlayed, answerPlayed].filter((v): v is number => v !== null);
  const solverReq = marks["solver.request"];
  const solverDone = marks["solver.done"];
  const ttsBase = marks["solver.spokenReady"] ?? marks["llm.firstToken"];
  const ansTts = marks["answer.ttsFirstByte"];
  return {
    ttfa: played.length ? Math.min(...played) : null,
    tta: answerPlayed,
    stt: rel("stt.final"),
    llmFirst: rel("llm.firstToken"),
    toolCall: rel("llm.toolCall"),
    solverFirst: rel("solver.firstToken"),
    solverSpoken: rel("solver.spokenReady"),
    solverTotal: solverReq !== undefined && solverDone !== undefined ? solverDone - solverReq : null,
    ttsFirst: ansTts !== undefined && ttsBase !== undefined ? ansTts - ttsBase : null,
  };
}

/** Only ack and answer segments carry marks (filler/notice don't count toward TTFA/TTA). */
export type MarkedSegment = "ack" | "answer";
export const isMarkedSegment = (s: string): s is MarkedSegment => s === "ack" || s === "answer";
