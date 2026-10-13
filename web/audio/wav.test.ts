import { describe, expect, it } from "vitest";
import { encodeWav, parseWav } from "./wav.ts";

/** Build a WAV by hand: interleaved samples written by `write`. */
function makeWav(opts: {
  format: number; channels: number; rate: number; bits: number; frames: number;
  write: (dv: DataView, off: number, frame: number, ch: number) => void;
  extensibleSub?: number; extraChunk?: boolean; oddChunk?: boolean;
}): ArrayBuffer {
  const { channels, rate, bits, frames } = opts;
  const bytes = bits / 8;
  const fmtLen = opts.extensibleSub !== undefined ? 40 : 16;
  const extra = opts.extraChunk ? 8 + (opts.oddChunk ? 3 : 4) + (opts.oddChunk ? 1 : 0) : 0;
  const dataLen = frames * channels * bytes;
  const buf = new ArrayBuffer(12 + 8 + fmtLen + extra + 8 + dataLen);
  const dv = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  dv.setUint32(4, buf.byteLength - 8, true);
  str(8, "WAVE");
  let o = 12;
  str(o, "fmt ");
  dv.setUint32(o + 4, fmtLen, true);
  dv.setUint16(o + 8, opts.extensibleSub !== undefined ? 0xfffe : opts.format, true);
  dv.setUint16(o + 10, channels, true);
  dv.setUint32(o + 12, rate, true);
  dv.setUint32(o + 16, rate * channels * bytes, true);
  dv.setUint16(o + 20, channels * bytes, true);
  dv.setUint16(o + 22, bits, true);
  if (opts.extensibleSub !== undefined) {
    dv.setUint16(o + 24, 22, true);
    dv.setUint16(o + 32, opts.extensibleSub, true);
  }
  o += 8 + fmtLen;
  if (opts.extraChunk) {
    str(o, "LIST");
    const size = opts.oddChunk ? 3 : 4;
    dv.setUint32(o + 4, size, true);
    o += 8 + size + (size & 1);
  }
  str(o, "data");
  dv.setUint32(o + 4, dataLen, true);
  o += 8;
  for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++) {
    opts.write(dv, o, f, c);
    o += bytes;
  }
  return buf;
}

describe("parseWav", () => {
  it("16-bit PCM mono", () => {
    const wav = makeWav({ format: 1, channels: 1, rate: 16000, bits: 16, frames: 3, write: (dv, o, f) => dv.setInt16(o, [0, 16384, -32768][f]!, true) });
    const d = parseWav(wav);
    expect(d.sampleRate).toBe(16000);
    expect(d.channels.length).toBe(1);
    expect(Array.from(d.channels[0]!)).toEqual([0, 0.5, -1]);
    expect(d.format).toBe(1);
  });

  it("16-bit PCM stereo, with a LIST chunk (odd size, padded) before data", () => {
    const wav = makeWav({
      format: 1, channels: 2, rate: 44100, bits: 16, frames: 2, extraChunk: true, oddChunk: true,
      write: (dv, o, f, c) => dv.setInt16(o, c === 0 ? 8192 * (f + 1) : -8192, true),
    });
    const d = parseWav(wav);
    expect(d.sampleRate).toBe(44100);
    expect(Array.from(d.channels[0]!)).toEqual([0.25, 0.5]);
    expect(Array.from(d.channels[1]!)).toEqual([-0.25, -0.25]);
  });

  it("32-bit float stereo", () => {
    const wav = makeWav({ format: 3, channels: 2, rate: 48000, bits: 32, frames: 2, write: (dv, o, f, c) => dv.setFloat32(o, c ? -0.75 : 0.125 * f, true) });
    const d = parseWav(wav);
    expect(d.format).toBe(3);
    expect(Array.from(d.channels[0]!)).toEqual([0, 0.125]);
    expect(Array.from(d.channels[1]!)).toEqual([-0.75, -0.75]);
  });

  it("WAVE_FORMAT_EXTENSIBLE with float subformat", () => {
    const wav = makeWav({ format: 3, extensibleSub: 3, channels: 1, rate: 22050, bits: 32, frames: 1, write: (dv, o) => dv.setFloat32(o, 0.5, true) });
    const d = parseWav(wav);
    expect(d.format).toBe(3);
    expect(d.channels[0]![0]).toBe(0.5);
  });

  it("24-bit PCM", () => {
    const wav = makeWav({
      format: 1, channels: 1, rate: 8000, bits: 24, frames: 2,
      write: (dv, o, f) => {
        const v = f === 0 ? 0x400000 : -0x800000;
        dv.setUint8(o, v & 0xff);
        dv.setUint8(o + 1, (v >> 8) & 0xff);
        dv.setUint8(o + 2, (v >> 16) & 0xff);
      },
    });
    expect(Array.from(parseWav(wav).channels[0]!)).toEqual([0.5, -1]);
  });

  it("rejects non-WAV and unsupported formats", () => {
    expect(() => parseWav(new ArrayBuffer(20))).toThrow(/RIFF/);
    const alaw = makeWav({ format: 6, channels: 1, rate: 8000, bits: 8, frames: 1, write: () => {} });
    expect(() => parseWav(alaw)).toThrow(/unsupported/);
  });

  it("truncated data chunk is clamped to the bytes present", () => {
    const wav = makeWav({ format: 1, channels: 1, rate: 24000, bits: 16, frames: 4, write: (dv, o) => dv.setInt16(o, 100, true) });
    const d = parseWav(wav.slice(0, wav.byteLength - 3)); // 8 data bytes → 5: two whole samples left
    expect(d.channels[0]!.length).toBe(2);
  });
});

describe("encodeWav", () => {
  it("round-trips through parseWav as 16-bit mono 24 kHz", () => {
    const a = Int16Array.from([0, 1000, -1000]);
    const b = Int16Array.from([32767, -32768]);
    const wav = encodeWav([a, b]);
    expect(wav.byteLength).toBe(44 + 10);
    const d = parseWav(wav);
    expect(d.sampleRate).toBe(24000);
    expect(d.bitsPerSample).toBe(16);
    expect(d.channels.length).toBe(1);
    expect(Array.from(d.channels[0]!, (v) => Math.round(v * 0x8000))).toEqual([0, 1000, -1000, 32767, -32768]);
  });
});
