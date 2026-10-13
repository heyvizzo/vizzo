// WAV fixture → 24 kHz PCM16 frames at real-time pace, plus cursor-trail replay. Implemented by T2.
import type { CursorSample } from "../../shared/protocol.ts";

export interface ReplayOpts {
  wav: ArrayBuffer;
  /** Cursor trail recorded with the WAV; sample.t is ms relative to the first audio sample. */
  cursor?: CursorSample[];
  onFrame: (pcm: Int16Array<ArrayBuffer>) => void;
  /** Called with each cursor sample re-timed into the current performance.now() clock. */
  onCursor?: (sample: CursorSample) => void;
}

export interface ReplayHandle {
  readonly tAudioStart: Promise<number>;
  /** Resolves after the last frame was sent (the auto "release" point). */
  readonly done: Promise<void>;
  stop(): void;
}

export function startReplay(_opts: ReplayOpts): ReplayHandle {
  throw new Error("startReplay: not implemented (T2)");
}
