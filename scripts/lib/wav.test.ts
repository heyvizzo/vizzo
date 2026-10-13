import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseWav, writeWavPcm16 } from "./wav.ts";

describe("wav", () => {
  it("round-trips PCM16 mono", () => {
    const pcm = Buffer.from([1, 0, 2, 0, 3, 0]);
    const w = parseWav(writeWavPcm16(pcm, 24000));
    expect(w).toMatchObject({ sampleRate: 24000, channels: 1, bitsPerSample: 16, format: 1 });
    expect(w.data.equals(pcm)).toBe(true);
  });
  it("parses the smoke fixture (skips LIST chunk)", () => {
    const w = parseWav(readFileSync(new URL("../../fixtures/smoke/hello.wav", import.meta.url)));
    expect(w).toMatchObject({ sampleRate: 24000, channels: 1, bitsPerSample: 16, format: 1 });
    expect(w.data.length).toBeGreaterThan(24000);
  });
  it("rejects non-wav", () => expect(() => parseWav(Buffer.from("nope nope nope"))).toThrow());
});
