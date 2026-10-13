// WAV (RIFF) parse + encode. Pure, no DOM.
// Parse supports PCM 8/16/24/32-bit integer and 32/64-bit IEEE float, any channel count and sample rate,
// including WAVE_FORMAT_EXTENSIBLE. Encode writes 16-bit PCM.

export interface DecodedWav {
  sampleRate: number;
  /** One Float32Array (−1..1) per channel. */
  channels: Float32Array<ArrayBuffer>[];
  /** Original bits per sample and format tag (1 = PCM, 3 = float), after resolving EXTENSIBLE. */
  bitsPerSample: number;
  format: 1 | 3;
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

export function parseWav(buf: ArrayBuffer): DecodedWav {
  const dv = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (buf.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a RIFF/WAVE file");

  let fmt: { format: number; channels: number; sampleRate: number; bits: number; blockAlign: number } | null = null;
  let dataOff = -1;
  let dataLen = 0;
  let off = 12;
  while (off + 8 <= buf.byteLength) {
    const id = tag(off);
    const size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      let format = dv.getUint16(body, true);
      const channels = dv.getUint16(body + 2, true);
      const sampleRate = dv.getUint32(body + 4, true);
      const blockAlign = dv.getUint16(body + 12, true);
      const bits = dv.getUint16(body + 14, true);
      // EXTENSIBLE: the real format is the first 2 bytes of the SubFormat GUID at body+24.
      if (format === FORMAT_EXTENSIBLE && size >= 40) format = dv.getUint16(body + 24, true);
      fmt = { format, channels, sampleRate, bits, blockAlign };
    } else if (id === "data") {
      dataOff = body;
      // Streamed WAVs sometimes have size 0 or 0xFFFFFFFF; clamp to the bytes actually present.
      dataLen = Math.min(size === 0 ? Infinity : size, buf.byteLength - body);
      break;
    }
    off = body + size + (size & 1); // chunks are word-aligned
  }
  if (!fmt) throw new Error("WAV: missing fmt chunk");
  if (dataOff < 0) throw new Error("WAV: missing data chunk");
  const { format, channels: nch, sampleRate, bits } = fmt;
  if (nch < 1) throw new Error("WAV: no channels");
  if (!(sampleRate > 0)) throw new Error("WAV: bad sample rate");
  const bytes = bits / 8;
  const blockAlign = fmt.blockAlign || nch * bytes;

  let read: (o: number) => number;
  if (format === FORMAT_PCM && bits === 16) read = (o) => dv.getInt16(o, true) / 0x8000;
  else if (format === FORMAT_PCM && bits === 8) read = (o) => (dv.getUint8(o) - 128) / 128;
  else if (format === FORMAT_PCM && bits === 24)
    read = (o) => ((dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16)) / 0x800000);
  else if (format === FORMAT_PCM && bits === 32) read = (o) => dv.getInt32(o, true) / 0x80000000;
  else if (format === FORMAT_FLOAT && bits === 32) read = (o) => dv.getFloat32(o, true);
  else if (format === FORMAT_FLOAT && bits === 64) read = (o) => dv.getFloat64(o, true);
  else throw new Error(`WAV: unsupported format ${format} / ${bits}-bit`);

  const frames = Math.floor(dataLen / blockAlign);
  const channels = Array.from({ length: nch }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    const base = dataOff + i * blockAlign;
    for (let c = 0; c < nch; c++) channels[c]![i] = read(base + c * bytes);
  }
  return { sampleRate, channels, bitsPerSample: bits, format: format === FORMAT_FLOAT ? 3 : 1 };
}

/** 16-bit PCM mono WAV from PCM16 chunks. */
export function encodeWav(chunks: readonly Int16Array[], sampleRate = 24_000): ArrayBuffer {
  const samples = chunks.reduce((n, c) => n + c.length, 0);
  const dataLen = samples * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  dv.setUint32(4, 36 + dataLen, true);
  str(8, "WAVE");
  str(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, FORMAT_PCM, true);
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); // byte rate
  dv.setUint16(32, 2, true); // block align
  dv.setUint16(34, 16, true);
  str(36, "data");
  dv.setUint32(40, dataLen, true);
  let o = 44;
  for (const c of chunks) for (let i = 0; i < c.length; i++, o += 2) dv.setInt16(o, c[i]!, true);
  return buf;
}
