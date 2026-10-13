// Record PCM16 24 kHz frames into a WAV file (used by the cursor lab / T10).
import { RATE } from "./dsp.ts";
import { encodeWav } from "./wav.ts";

export interface WavRecorder {
  push(pcm: Int16Array): void;
  /** 16-bit mono 24 kHz WAV. */
  toWav(): Blob;
}

export function createWavRecorder(): WavRecorder {
  const chunks: Int16Array[] = [];
  return {
    push(pcm) {
      chunks.push(pcm.slice()); // copy: callers may reuse or transfer the buffer
    },
    toWav() {
      return new Blob([encodeWav(chunks, RATE)], { type: "audio/wav" });
    },
  };
}
