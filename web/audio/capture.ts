// Mic → mono → 24 kHz → PCM16 LE frames of 20 ms (480 samples). Implemented by T2.

export interface CaptureHandle {
  /** performance.now() of the first captured sample (used as tAudioStart, ARCHITECTURE §6). */
  readonly tAudioStart: Promise<number>;
  stop(): void;
}

export interface CaptureOpts {
  /** Called for every 20 ms PCM16 24 kHz frame. */
  onFrame: (pcm: Int16Array<ArrayBuffer>) => void;
}

/** Starts capturing from the mic. Reuses one AudioContext + mic stream across calls. */
export async function startCapture(_opts: CaptureOpts): Promise<CaptureHandle> {
  throw new Error("startCapture: not implemented (T2)");
}
