// Pointing resolution (ARCHITECTURE §6). Pure functions. Implemented by T9.
import type { CursorSample, PointingTarget, Word } from "./protocol.ts";

export const POINTING_WORDS = /^(this|that|these|those|here|there)$/i;

export type Resolver = (word: Word, tAudioStart: number, samples: CursorSample[], opts?: WindowOpts) => CursorSample | null;
export interface WindowOpts { preMs: number; postMs: number }

export const RESOLVERS: Record<string, Resolver> = {};

/** Run every resolver on every pointing word. Stub until T9 lands. */
export function resolvePointing(_words: Word[], _tAudioStart: number, _samples: CursorSample[], _opts?: WindowOpts): PointingTarget[] {
  return [];
}

/** e.g. `Pointing: "this" → <button> "Get started" [data-source=web/cursor/demo.html:42]` */
export function formatPointingContext(_targets: PointingTarget[], _algorithm = "dwellMode"): string {
  return "";
}
