// Minimal RIFF/WAVE parser for server-side fixtures (PCM16 only). Walks chunks properly
// (handles LIST/INFO and other chunks before `data`, and odd-size chunk padding).

export interface WavPcm16 {
  sampleRate: number;
  channels: number;
  /** Raw little-endian PCM16 bytes (interleaved if channels > 1). */
  data: Buffer;
}

export function parseWav(buf: Buffer): WavPcm16 {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("parseWav: not a RIFF/WAVE file");
  }
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      if (size < 16) throw new Error("parseWav: fmt chunk too short");
      let format = buf.readUInt16LE(body);
      // WAVE_FORMAT_EXTENSIBLE: the real format code is the first 2 bytes of the SubFormat GUID.
      if (format === 0xfffe && size >= 40) format = buf.readUInt16LE(body + 24);
      fmt = { format, channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!fmt) throw new Error("parseWav: data chunk before fmt chunk");
      if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`parseWav: only PCM16 supported (format=${fmt.format}, bits=${fmt.bits})`);
      const end = Math.min(body + size, buf.length); // tolerate truncated/streamed sizes
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, data: buf.subarray(body, end) };
    }
    off = body + size + (size & 1);
  }
  throw new Error("parseWav: no data chunk");
}

export function writeWavPcm16(pcm: Buffer, sampleRate = 24000, channels = 1): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
