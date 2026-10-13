// Gapless PCM16 24 kHz playback per segment. Reports the first non-silent sample actually played. Implemented by T2.
import type { Segment } from "../../shared/protocol.ts";

export interface Player {
  /** Mark the start of a segment; following push() calls belong to it. */
  startSegment(segment: Segment): void;
  /** Queue PCM16 24 kHz mono LE audio for the current segment. */
  push(pcm: ArrayBuffer): void;
  endSegment(segment: Segment): void;
  /** Called once per segment with the performance.now() time its first non-silent sample was played. */
  onPlayed: ((segment: Segment, tPlayed: number) => void) | null;
  /** Drop queued audio (cancel / new turn). */
  reset(): void;
}

export async function createPlayer(): Promise<Player> {
  throw new Error("createPlayer: not implemented (T2)");
}
