// WAV fixture → 24 kHz PCM16 frames at real-time pace, plus cursor-trail replay.
import type { CursorSample } from "../../shared/protocol.ts";
import { FRAME_SAMPLES, RATE, downmix, resample, toFrames } from "./dsp.ts";
import { parseWav } from "./wav.ts";

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
  /** Resolves after the last frame was sent (the auto "release" point), or on stop(). */
  readonly done: Promise<void>;
  stop(): void;
}

const FRAME_MS = (FRAME_SAMPLES / RATE) * 1000; // 20

/** Decode any supported WAV to 24 kHz mono 20 ms PCM16 frames. */
export function wavToFrames(wav: ArrayBuffer): Int16Array<ArrayBuffer>[] {
  const { sampleRate, channels } = parseWav(wav);
  return toFrames(resample(downmix(channels), sampleRate, RATE));
}

export interface Clock {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
}

const browserClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Starts replaying immediately. tAudioStart = performance.now() at start = the (virtual) capture time of the first
 * sample. Like a live mic, frame k (audio [k·20, (k+1)·20) ms) is emitted once it has been fully "captured", at
 * tAudioStart + (k+1)·20 ms. Cursor samples are re-timed to t' = tAudioStart + t and emitted at t'.
 *
 * Scheduling is drift-free: every deadline is computed from tAudioStart (never from the previous timer firing), and
 * each wake-up emits everything that is due, so late timers catch up instead of accumulating delay. Note that
 * background tabs throttle timers to ~1 s; keep the tab visible while benchmarking.
 */
export function startReplay(opts: ReplayOpts): ReplayHandle {
  return startReplayWithClock(opts, browserClock);
}

/** startReplay with an injectable clock (tests). */
export function startReplayWithClock(opts: ReplayOpts, clock: Clock): ReplayHandle {
  let frames: Int16Array<ArrayBuffer>[];
  try {
    frames = wavToFrames(opts.wav);
  } catch (e) {
    const err = Promise.reject(e instanceof Error ? e : new Error(String(e)));
    err.catch(() => {});
    return { tAudioStart: err, done: err, stop: () => {} };
  }
  const cursor = [...(opts.cursor ?? [])].sort((a, b) => a.t - b.t);
  const t0 = clock.now();
  let fi = 0;
  let ci = 0;
  let timer: unknown = null;
  let stopped = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const frameDue = (k: number) => t0 + (k + 1) * FRAME_MS;
  const cursorDue = (k: number) => t0 + cursor[k]!.t;

  const tick = () => {
    timer = null;
    if (stopped) return;
    const now = clock.now();
    // Emit in time order across both streams.
    for (;;) {
      const fd = fi < frames.length ? frameDue(fi) : Infinity;
      const cd = ci < cursor.length ? cursorDue(ci) : Infinity;
      const next = Math.min(fd, cd);
      if (next > now || next === Infinity) break;
      if (cd <= fd) {
        const s = cursor[ci++]!;
        opts.onCursor?.({ ...s, t: t0 + s.t });
      } else {
        opts.onFrame(frames[fi++]!);
      }
      if (stopped) return;
    }
    if (fi >= frames.length) {
      // Cursor samples after the last frame are dropped: the turn is released at that point.
      resolveDone();
      return;
    }
    const next = Math.min(frameDue(fi), ci < cursor.length ? cursorDue(ci) : Infinity);
    timer = clock.setTimeout(tick, Math.max(0, next - clock.now()));
  };
  tick();

  return {
    tAudioStart: Promise.resolve(t0),
    done,
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clock.clearTimeout(timer);
      resolveDone();
    },
  };
}
