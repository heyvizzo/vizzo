// Pure helpers for the chat page: decision badges, estimates, job labels, Opus detail extraction,
// and a rough "is audio still playing" estimate. No DOM here (unit-tested in logic.test.ts).
import type { JobInfo, RouteIntent } from "../../shared/protocol.ts";

/** Seconds → "~8 s", "~1.5 min", "~2 min", "~1 h". null/invalid → "". */
export function fmtEstimate(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s) || s < 0) return "";
  if (s < 1) return "<1 s";
  if (s < 60) return `~${Math.round(s)} s`;
  if (s < 3600) {
    const m = s / 60;
    return `~${m < 10 ? trimNum(Math.round(m * 2) / 2) : Math.round(m)} min`;
  }
  return `~${trimNum(Math.round((s / 3600) * 2) / 2)} h`;
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Elapsed ms → "0 s", "42 s", "1 min 14 s", "12 min". */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m >= 10 || r === 0 ? `${m} min` : `${m} min ${r} s`;
}

export interface DecisionLike { intent: RouteIntent; estimateS: number | null; background: boolean }

/** Badge texts for a turn's decision, e.g. ["task", "~2 min", "working in background"]. */
export function decisionBadges(d: DecisionLike): string[] {
  if (d.intent === "clarify") return ["asking you a follow-up"];
  if (d.intent === "answer") return ["direct answer"];
  const out: string[] = [d.intent];
  const est = fmtEstimate(d.estimateS);
  if (est) out.push(est);
  if (d.background) out.push("working in background");
  return out;
}

/** Opus streams `SPOKEN: …` + blank line + details. Returns the details part (the spoken line is said aloud). */
export function detailOf(opusText: string): string {
  if (!/^\s*SPOKEN:/i.test(opusText)) return opusText;
  const i = opusText.search(/\n\s*\n/);
  return i < 0 ? "" : opusText.slice(i).trim();
}

/** Drop a leading `SPOKEN:` prefix from a spoken line. */
export function spokenOf(text: string): string {
  return text.replace(/^\s*SPOKEN:\s*/i, "").trim();
}

/** Headline for a job card. */
export function jobHeadline(job: Pick<JobInfo, "state" | "intent" | "elapsedMs">, elapsedMs: number): string {
  const kind = job.intent === "question" ? "question" : "task";
  if (job.state === "running") return `Background ${kind} · running ${fmtElapsed(elapsedMs)}`;
  const took = job.elapsedMs ?? elapsedMs;
  if (job.state === "done") return `Done in ${fmtElapsed(took)}`;
  return `Failed after ${fmtElapsed(took)}`;
}

/** "1 task running", "3 tasks running", "" for none. */
export function runningLabel(n: number): string {
  return n <= 0 ? "" : `${n} task${n === 1 ? "" : "s"} running`;
}

const BYTES_PER_SECOND = 24000 * 2; // PCM16 mono 24 kHz

/**
 * Estimates whether queued audio is still audible: each push extends a "playing until" time by the chunk's
 * duration (from now, or from the end of what's already queued). Times are performance.now() ms.
 */
export class PlaybackClock {
  private until = 0;
  push(bytes: number, now: number): void {
    this.until = Math.max(this.until, now) + (bytes / BYTES_PER_SECOND) * 1000;
  }
  reset(): void {
    this.until = 0;
  }
  isPlaying(now: number): boolean {
    return now < this.until;
  }
  remainingMs(now: number): number {
    return Math.max(0, this.until - now);
  }
}
