import { describe, expect, it } from "vitest";
import type { CursorSample } from "../../shared/protocol.ts";
import { startReplayWithClock, wavToFrames, type Clock } from "./replay.ts";
import { encodeWav } from "./wav.ts";

/** Fake clock: timers fire in deadline order; each firing is late by `lateMs` (simulated jitter). */
function fakeClock(lateMs = 0) {
  let t = 1000;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => t,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: t + ms + lateMs, fn });
      return id;
    },
    clearTimeout: (h) => void timers.delete(h as number),
  };
  const runAll = () => {
    for (let guard = 0; timers.size && guard < 100000; guard++) {
      const [id, next] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]!;
      timers.delete(id);
      t = Math.max(t, next.at);
      next.fn();
    }
  };
  return { clock, runAll, now: () => t };
}

const sample = (t: number): CursorSample => ({ t, x: t, y: 0, scrollX: 0, scrollY: 0, elementPath: null, dataSource: null, label: null });

/** 48 kHz stereo 16-bit WAV of `ms` milliseconds. */
function wav48kStereo(ms: number): ArrayBuffer {
  // encodeWav is mono 24k; build stereo 48k by hand by patching the header of a mono file with doubled data.
  const frames = (48000 * ms) / 1000;
  const mono = encodeWav([new Int16Array(frames * 2).fill(1000)], 48000);
  const dv = new DataView(mono);
  dv.setUint16(22, 2, true); // channels
  dv.setUint32(28, 48000 * 4, true);
  dv.setUint16(32, 4, true);
  return mono;
}

describe("wavToFrames", () => {
  it("48 kHz stereo → 24 kHz 20 ms frames", () => {
    const frames = wavToFrames(wav48kStereo(100));
    expect(frames.length).toBe(5);
    expect(frames.every((f) => f.length === 480)).toBe(true);
    expect(frames[2]![200]).toBeGreaterThan(990);
    expect(frames[2]![200]).toBeLessThan(1010);
  });

  it("pads the last partial frame", () => {
    expect(wavToFrames(encodeWav([new Int16Array(500)], 24000)).length).toBe(2);
  });
});

describe("startReplay pacing", () => {
  it("emits frame k at tAudioStart + (k+1)·20 ms and resolves done after the last one", async () => {
    const fc = fakeClock();
    const at: number[] = [];
    const h = startReplayWithClock({ wav: encodeWav([new Int16Array(480 * 10)], 24000), onFrame: () => at.push(fc.now()) }, fc.clock);
    const t0 = await h.tAudioStart;
    expect(t0).toBe(1000);
    fc.runAll();
    await h.done;
    expect(at).toEqual(Array.from({ length: 10 }, (_, k) => t0 + (k + 1) * 20));
  });

  it("does not accumulate drift when timers fire late (catch-up)", () => {
    const fc = fakeClock(7); // every timer 7 ms late
    const at: number[] = [];
    startReplayWithClock({ wav: encodeWav([new Int16Array(480 * 100)], 24000), onFrame: () => at.push(fc.now()) }, fc.clock);
    fc.runAll();
    expect(at.length).toBe(100);
    // Each frame is at most one timer-lateness behind its deadline, never more.
    at.forEach((t, k) => {
      const due = 1000 + (k + 1) * 20;
      expect(t).toBeGreaterThanOrEqual(due);
      expect(t - due).toBeLessThanOrEqual(7);
    });
  });

  it("re-times cursor samples into the live clock and interleaves them by time", () => {
    const fc = fakeClock();
    const events: string[] = [];
    const cursor = [sample(30), sample(-5), sample(0), sample(55)];
    const seen: CursorSample[] = [];
    startReplayWithClock(
      {
        wav: encodeWav([new Int16Array(480 * 3)], 24000),
        cursor,
        onFrame: () => events.push(`f@${fc.now()}`),
        onCursor: (s) => {
          seen.push(s);
          events.push(`c${s.x}@${fc.now()}`);
        },
      },
      fc.clock,
    );
    fc.runAll();
    expect(seen.map((s) => s.t)).toEqual([995, 1000, 1030, 1055]);
    expect(events).toEqual(["c-5@1000", "c0@1000", "f@1020", "c30@1030", "f@1040", "c55@1055", "f@1060"]);
  });

  it("stop() halts emission and resolves done", async () => {
    const fc = fakeClock();
    let n = 0;
    const h = startReplayWithClock({ wav: encodeWav([new Int16Array(480 * 50)], 24000), onFrame: () => ++n === 3 && h.stop() }, fc.clock);
    fc.runAll();
    await h.done;
    expect(n).toBe(3);
  });

  it("rejects tAudioStart/done for an invalid WAV", async () => {
    const h = startReplayWithClock({ wav: new ArrayBuffer(10), onFrame: () => {} }, fakeClock().clock);
    await expect(h.tAudioStart).rejects.toThrow(/RIFF/);
    await expect(h.done).rejects.toThrow();
  });
});
