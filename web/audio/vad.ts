// Always-listen gate. The meter draws the same level this compares against the line.
// A short attack ignores one noisy frame. The hang is the two seconds the level must
// stay under the line before the turn is sent. After Shift or the button ends a turn,
// disarm until the level falls, so that key does not immediately open another one.

/** How long the level must stay above the line before a turn starts. */
export const VAD_ATTACK_MS = 50;
/** How long the level must stay under the line before the turn is sent. */
export const VAD_HANG_MS = 2_000;
/** Range of the user's hang setting (the "Send after … s of quiet" box). */
export const VAD_HANG_MIN_MS = 500;
export const VAD_HANG_MAX_MS = 30_000;

/** A saved or typed hang (ms) that isn't a finite number becomes the default; others are clamped to the range. */
export function clampHangMs(ms: unknown): number {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return VAD_HANG_MS;
  return Math.min(VAD_HANG_MAX_MS, Math.max(VAD_HANG_MIN_MS, Math.round(ms)));
}
/**
 * Always-listen speech shorter than this (time the level stayed over the line, after the attack)
 * is a bump or a click. The turn is dropped instead of transcribed.
 */
export const VAD_MIN_SPEECH_MS = 300;

/** An always-listen turn that ended on silence and never became a real utterance. */
export function autoSpeechTooShort(speechMs: number): boolean {
  return !Number.isFinite(speechMs) || speechMs < VAD_MIN_SPEECH_MS;
}
/**
 * While a reply is already in flight (thinking, speaking, or a notice), wait longer
 * before treating a cross as a barge-in, so a brief leak of the speaker doesn't cancel it.
 */
export const VAD_BARGE_ATTACK_MS = 300;

/**
 * A dip under the line shorter than this doesn't restart the attack: speech falls between
 * syllables (and echo cancellation ducks it while a reply plays), so an unbroken run is rare.
 */
export const VAD_ATTACK_GAP_MS = 150;

/**
 * An always-listen turn's audio starts this long before the gate opened (the attack, any gaps
 * in it, and the time to start capture), so its first words aren't cut off.
 */
export const VAD_PRE_ROLL_MS = 600;

export function attackMs(turnInFlight: boolean): number {
  return turnInFlight ? VAD_BARGE_ATTACK_MS : VAD_ATTACK_MS;
}

export interface Vad {
  phase: "idle" | "open" | "hang";
  /** When the current attack or hang began (performance.now()). */
  since: number | null;
  /** False after a manual stop until the level falls under the line. */
  armed: boolean;
  /** Last sample on or above the line during the attack. */
  lastAbove: number | null;
}

export function createVad(): Vad {
  return { phase: "idle", since: null, armed: true, lastAbove: null };
}

export type VadEdge = "start" | "stop" | null;

/**
 * Advance the gate by one level sample. Mutates `v`. `hangMs` / `attackMs` override the defaults
 * (the barge-in attack is longer). Returns `start` once when a turn should open and `stop` once
 * when the hang has lasted long enough.
 */
export function stepVad(
  v: Vad,
  level: number,
  threshold: number,
  now: number,
  hangMs = VAD_HANG_MS,
  attackMs = VAD_ATTACK_MS,
): VadEdge {
  if (!Number.isFinite(level) || !Number.isFinite(threshold) || !Number.isFinite(now)) return null;
  const above = level >= threshold;
  // A sample under the line re-arms after Shift, including the one that completes a hang.
  if (!above) v.armed = true;

  if (v.phase === "open") {
    if (above) return null;
    v.phase = "hang";
    v.since = now;
    return null;
  }

  if (v.phase === "hang") {
    if (above) {
      v.phase = "open";
      v.since = null;
      return null;
    }
    if (v.since !== null && now - v.since >= hangMs) {
      v.phase = "idle";
      v.since = null;
      return "stop";
    }
    return null;
  }

  if (!v.armed) {
    v.since = null;
    return null;
  }
  if (!above) {
    if (v.since !== null && (v.lastAbove === null || now - v.lastAbove > VAD_ATTACK_GAP_MS)) v.since = null;
    return null;
  }
  v.lastAbove = now;
  if (v.since === null) v.since = now;
  if (now - v.since >= attackMs) {
    v.phase = "open";
    v.since = null;
    return "start";
  }
  return null;
}

/** Shift or the button ended the turn. Ignore the line until the level falls under it. */
export function disarmVad(v: Vad): void {
  v.phase = "idle";
  v.since = null;
  v.lastAbove = null;
  v.armed = false;
}
