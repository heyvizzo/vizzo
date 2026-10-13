// One shared AudioContext (capture + playback) and one mic stream, created lazily and reused.
// Worklet modules are bundled by Vite via `?worker&url`: in dev that URL serves the transformed TS module, and in
// `vite build` it is emitted as a standalone JS chunk (imports inlined), which `addModule` loads fine.
import captureWorkletUrl from "./capture-worklet.ts?worker&url";
import playerWorkletUrl from "./player-worklet.ts?worker&url";
import type { ClockSnapshot } from "./timing.ts";

let ctxPromise: Promise<AudioContext> | null = null;
let micPromise: Promise<MediaStream> | null = null;

/** The shared AudioContext (native sample rate, interactive latency) with both worklets loaded. Resumes it. */
export function getAudioContext(): Promise<AudioContext> {
  ctxPromise ??= (async () => {
    const ctx = new AudioContext({ latencyHint: "interactive" });
    await Promise.all([ctx.audioWorklet.addModule(captureWorkletUrl), ctx.audioWorklet.addModule(playerWorkletUrl)]);
    return ctx;
  })().catch((e) => {
    ctxPromise = null;
    throw e;
  });
  return ctxPromise.then(async (ctx) => {
    if (ctx.state !== "running") await ctx.resume().catch(() => {});
    return ctx;
  });
}

/**
 * The shared mic stream. Constraints:
 * - echoCancellation ON: the page plays audio (echo test, agent replies) through speakers; without AEC the reply
 *   leaks back into the mic and into STT. Chrome's AEC uses Web Audio output as its reference.
 * - noiseSuppression / autoGainControl OFF: keep levels and timing as raw as possible (AGC pumps levels across a
 *   turn, NS can clip word onsets), which matters for word timestamps. STT vendors handle mild noise fine.
 * - channelCount 1 ideal; we downmix anyway.
 */
export function getMicStream(): Promise<MediaStream> {
  micPromise ??= navigator.mediaDevices
    .getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 1 } },
    })
    .catch((e) => {
      micPromise = null;
      throw e;
    });
  return micPromise.then((s) => {
    if (s.getAudioTracks().some((t) => t.readyState === "ended")) {
      micPromise = null;
      return getMicStream();
    }
    return s;
  });
}

/** Ask for mic permission + start the context ahead of the first turn (call from a user gesture). */
export async function warmUpAudio(): Promise<void> {
  await Promise.all([getAudioContext(), getMicStream()]);
}

/** Read the context's clocks together for timing.ts. */
export function clockSnapshot(ctx: AudioContext): ClockSnapshot {
  const ts = ctx.getOutputTimestamp?.() ?? {};
  return {
    ts,
    currentTime: ctx.currentTime,
    now: performance.now(),
    baseLatency: ctx.baseLatency ?? 0,
    outputLatency: ctx.outputLatency ?? 0,
  };
}
