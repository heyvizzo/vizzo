// Resolver accuracy against labeled sessions (PRD FR13, success metric "Resolver accuracy").
import { ALGORITHMS, RESOLVERS, type WindowOpts } from "../../shared/pointing.ts";
import type { CursorSample } from "../../shared/protocol.ts";
import type { LabelTarget, LabSession } from "./session.ts";

/**
 * A pick is correct when it lands on the labeled target: same data-source when the label has one
 * (targets are the [data-source] elements, so clicking a child of a card still counts as the card),
 * otherwise the same elementPath.
 */
export function targetMatches(sample: CursorSample | null, target: LabelTarget | null): boolean {
  if (!sample || !target) return false;
  if (target.dataSource) return sample.dataSource === target.dataSource;
  return target.elementPath !== null && sample.elementPath === target.elementPath;
}

export interface Tally { correct: number; total: number }
export interface ScoreDetail { sessionId: string; wordIndex: number; word: string; algorithm: string; correct: boolean; pick: CursorSample | null }
export interface Scores {
  algorithms: string[];
  overall: Record<string, Tally>;
  perSession: Record<string, Record<string, Tally>>;
  details: ScoreDetail[];
}

/** Score every algorithm on every labeled pointing word (unlabeled words are skipped). */
export function scoreSessions(sessions: readonly LabSession[], opts: WindowOpts): Scores {
  const overall: Record<string, Tally> = {};
  const perSession: Record<string, Record<string, Tally>> = {};
  const details: ScoreDetail[] = [];
  for (const a of ALGORITHMS) overall[a] = { correct: 0, total: 0 };
  for (const s of sessions) {
    const ps: Record<string, Tally> = (perSession[s.id] = {});
    for (const a of ALGORITHMS) ps[a] = { correct: 0, total: 0 };
    for (const l of s.labels) {
      const word = s.words[l.wordIndex];
      if (!l.target || !word) continue;
      for (const a of ALGORITHMS) {
        const pick = RESOLVERS[a]!(word, 0, s.samples, opts);
        const correct = targetMatches(pick, l.target);
        for (const t of [overall[a]!, ps[a]!]) {
          t.total++;
          if (correct) t.correct++;
        }
        details.push({ sessionId: s.id, wordIndex: l.wordIndex, word: l.word, algorithm: a, correct, pick });
      }
    }
  }
  return { algorithms: [...ALGORITHMS], overall, perSession, details };
}

export const pct = (t: Tally): string => (t.total ? `${Math.round((100 * t.correct) / t.total)}%` : "–");
