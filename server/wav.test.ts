import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseWav } from "./wav.ts";

function wav(chunks: [string, Buffer][]): Buffer {
  const body = Buffer.concat(
    chunks.map(([id, b]) => {
      const h = Buffer.alloc(8);
      h.write(id, 0, "ascii");
      h.writeUInt32LE(b.length, 4);
      return Buffer.concat([h, b, b.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    }),
  );
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(body.length + 4, 4);
  head.write("WAVE", 8, "ascii");
  return Buffer.concat([head, body]);
}
function fmt(rate: number, ch: number, bits = 16, format = 1): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt16LE(format, 0);
  b.writeUInt16LE(ch, 2);
  b.writeUInt32LE(rate, 4);
  b.writeUInt32LE((rate * ch * bits) / 8, 8);
  b.writeUInt16LE((ch * bits) / 8, 12);
  b.writeUInt16LE(bits, 14);
  return b;
}

describe("parseWav", () => {
  it("skips odd-sized chunks before data", () => {
    const data = Buffer.from([1, 0, 2, 0]);
    const w = parseWav(wav([["fmt ", fmt(24000, 1)], ["LIST", Buffer.from("abc")], ["data", data]]));
    expect(w).toEqual({ sampleRate: 24000, channels: 1, data });
  });
  it("rejects non-PCM16 and non-WAV input", () => {
    expect(() => parseWav(wav([["fmt ", fmt(24000, 1, 8)], ["data", Buffer.alloc(2)]]))).toThrow(/PCM16/);
    expect(() => parseWav(Buffer.from("nope nope nope"))).toThrow(/RIFF/);
  });
  it("parses the bundled smoke fixture as 24 kHz mono", () => {
    const w = parseWav(readFileSync(new URL("../fixtures/smoke/hello.wav", import.meta.url)));
    expect(w.sampleRate).toBe(24000);
    expect(w.channels).toBe(1);
    expect(w.data.length).toBeGreaterThan(24000);
  });
});
