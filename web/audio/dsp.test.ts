import { describe, expect, it } from "vitest";
import { Framer, Resampler, bytesToPcm16, downmix, firstNonSilent, floatToPcm16, pcm16ToFloat, resample, toFrames } from "./dsp.ts";

const sine = (freq: number, rate: number, n: number, amp = 0.5, phase = 0) =>
  Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate + phase));

/** RMS over the middle of a buffer (skip filter edges). */
const rms = (x: Float32Array, skip = 200) => {
  let s = 0;
  const a = x.subarray(skip, x.length - skip);
  for (const v of a) s += v * v;
  return Math.sqrt(s / a.length);
};

/** Max abs error vs an ideal sine at the output rate (middle only). */
const maxErr = (x: Float32Array, freq: number, rate: number, amp = 0.5, skip = 200) => {
  let m = 0;
  for (let i = skip; i < x.length - skip; i++) m = Math.max(m, Math.abs(x[i]! - amp * Math.sin((2 * Math.PI * freq * i) / rate)));
  return m;
};

describe("PCM conversion", () => {
  it("float ↔ pcm16 round trip and clamping", () => {
    const f = Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2]);
    const p = floatToPcm16(f);
    expect(Array.from(p)).toEqual([0, 16384, -16384, 32767, -32768, 32767, -32768]);
    const back = pcm16ToFloat(p);
    expect(back[1]).toBeCloseTo(0.5, 4);
    expect(back[4]).toBe(-1);
  });

  it("bytesToPcm16 reads little-endian", () => {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setInt16(0, -2, true);
    new DataView(buf).setInt16(2, 300, true);
    expect(Array.from(bytesToPcm16(buf))).toEqual([-2, 300]);
  });

  it("downmix averages channels", () => {
    expect(Array.from(downmix([Float32Array.from([1, 0]), Float32Array.from([0, 1])]))).toEqual([0.5, 0.5]);
    expect(Array.from(downmix([Float32Array.from([0.25])]))).toEqual([0.25]);
  });

  it("firstNonSilent on float and pcm16", () => {
    expect(firstNonSilent(Float32Array.from([0, 0.0005, 0.01, 0.5]))).toBe(2);
    expect(firstNonSilent(Int16Array.from([0, 10, 100]))).toBe(2);
    expect(firstNonSilent(new Float32Array(10))).toBe(-1);
  });
});

describe("Resampler", () => {
  it("48k → 24k preserves a 1 kHz sine (amplitude and phase)", () => {
    const out = resample(sine(1000, 48000, 48000), 48000, 24000);
    expect(out.length).toBe(24000);
    expect(maxErr(out, 1000, 24000)).toBeLessThan(0.01);
  });

  it("44.1k → 24k preserves a 440 Hz sine, length = round(n·24000/44100)", () => {
    const n = 44100;
    const out = resample(sine(440, 44100, n), 44100, 24000);
    expect(out.length).toBe(24000);
    expect(maxErr(out, 440, 24000)).toBeLessThan(0.01);
  });

  it("16k → 24k upsampling preserves a 1 kHz sine", () => {
    const out = resample(sine(1000, 16000, 16000), 16000, 24000);
    expect(out.length).toBe(24000);
    expect(maxErr(out, 1000, 24000)).toBeLessThan(0.01);
  });

  it("anti-aliasing: content above the new Nyquist is strongly attenuated", () => {
    // 18 kHz at 48k would alias to 6 kHz at 24k without filtering.
    const out = resample(sine(18000, 48000, 48000), 48000, 24000);
    expect(rms(out)).toBeLessThan(0.005); // input RMS ≈ 0.354
  });

  it("DC is preserved exactly", () => {
    const out = resample(new Float32Array(4800).fill(0.3), 48000, 24000);
    for (let i = 50; i < out.length - 50; i++) expect(out[i]).toBeCloseTo(0.3, 5);
  });

  it("streaming in odd-sized chunks equals one-shot", () => {
    const input = sine(700, 44100, 10000);
    const oneShot = resample(input, 44100, 24000);
    const r = new Resampler(44100, 24000);
    const parts: Float32Array[] = [];
    let i = 0;
    for (const size of [1, 127, 128, 333, 5, 4000]) {
      parts.push(r.process(input.subarray(i, i + size)));
      i += size;
    }
    parts.push(r.process(input.subarray(i)));
    parts.push(r.flush());
    const streamed = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      streamed.set(p, o);
      o += p.length;
    }
    expect(streamed.length).toBe(oneShot.length);
    for (let k = 0; k < oneShot.length; k++) expect(streamed[k]).toBeCloseTo(oneShot[k]!, 6);
  });

  it("output lags input by at most halfTaps input samples while streaming", () => {
    const r = new Resampler(48000, 24000, 16);
    let produced = 0;
    for (let k = 0; k < 100; k++) produced += r.process(new Float32Array(128)).length;
    const ideal = (100 * 128) / 2;
    expect(ideal - produced).toBeLessThanOrEqual(9);
    expect(produced).toBeLessThanOrEqual(ideal);
  });

  it("timing: an impulse at input t lands at output t", () => {
    const input = new Float32Array(4800);
    input[2400] = 1; // 50 ms at 48k
    const out = resample(input, 48000, 24000);
    let peak = 0;
    for (let i = 1; i < out.length; i++) if (Math.abs(out[i]!) > Math.abs(out[peak]!)) peak = i;
    expect(peak).toBe(1200); // 50 ms at 24k
  });

  it("equal rates pass through", () => {
    const x = sine(100, 24000, 1000);
    expect(Array.from(resample(x, 24000, 24000))).toEqual(Array.from(x));
  });

  it("reset restarts the stream", () => {
    const r = new Resampler(48000, 24000);
    const a = r.process(sine(1000, 48000, 960));
    r.reset();
    const b = r.process(sine(1000, 48000, 960));
    expect(Array.from(b)).toEqual(Array.from(a));
  });
});

describe("Framer", () => {
  it("emits 480-sample frames and zero-pads the flush", () => {
    const f = new Framer(480);
    const frames: Int16Array[] = [];
    f.push(new Float32Array(1000).fill(0.5), (fr) => frames.push(fr));
    expect(frames.length).toBe(2);
    f.flush((fr) => frames.push(fr));
    expect(frames.length).toBe(3);
    expect(frames[2]![39]).toBe(16384);
    expect(frames[2]![40]).toBe(0);
    expect(frames.every((fr) => fr.length === 480)).toBe(true);
  });

  it("emitted frames do not share buffers (safe to transfer)", () => {
    const frames = toFrames(new Float32Array(960).fill(0.1));
    expect(frames[0]!.buffer).not.toBe(frames[1]!.buffer);
  });
});
