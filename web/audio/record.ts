// Record PCM16 24 kHz frames into a WAV file (used by the cursor lab / T10). Implemented by T2.

export interface WavRecorder {
  push(pcm: Int16Array): void;
  /** 16-bit mono 24 kHz WAV. */
  toWav(): Blob;
}

export function createWavRecorder(): WavRecorder {
  throw new Error("createWavRecorder: not implemented (T2)");
}
