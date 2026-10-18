import { describe, expect, it } from "vitest";
import { createPcm16Resampler } from "./pcmResample.ts";

const sine = (n: number, rate: number, hz: number) => {
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(10000 * Math.sin((2 * Math.PI * hz * i) / rate)), i * 2);
  return b;
};

describe("createPcm16Resampler", () => {
  it("44.1 kHz → 24 kHz gives the right number of samples", () => {
    const rs = createPcm16Resampler(44100, 24000);
    const out = rs(sine(44100, 44100, 440)); // one second
    expect(Math.abs(out.length / 2 - 24000)).toBeLessThanOrEqual(1);
  });

  it("chunking does not change the output", () => {
    const input = sine(10000, 44100, 300);
    const whole = createPcm16Resampler(44100, 24000)(input);
    const rs = createPcm16Resampler(44100, 24000);
    const pieces: Buffer[] = [];
    // Uneven pieces, including odd byte counts, to exercise the carry.
    for (let at = 0, sizes = [1, 777, 3, 4096, 501]; at < input.length; ) {
      const n = Math.min(sizes[pieces.length % sizes.length]!, input.length - at);
      pieces.push(rs(input.subarray(at, at + n)));
      at += n;
    }
    expect(Buffer.concat(pieces).equals(whole)).toBe(true);
  });

  it("passes through when the rates match", () => {
    const b = sine(100, 24000, 100);
    expect(createPcm16Resampler(24000, 24000)(b)).toBe(b);
  });
});
