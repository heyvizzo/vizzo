// Minimal RIFF/WAVE helpers for smoke scripts: parse PCM16 (walks chunks, skips LIST etc.), write PCM16 mono.

export interface WavInfo { sampleRate: number; channels: number; bitsPerSample: number; format: number; data: Buffer }

export function parseWav(buf: Buffer): WavInfo {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("parseWav: not a RIFF/WAVE file");
  }
  let fmt: Omit<WavInfo, "data"> | null = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!fmt) throw new Error("parseWav: data chunk before fmt chunk");
      return { ...fmt, data: buf.subarray(body, Math.min(body + size, buf.length)) };
    }
    off = body + size + (size & 1); // chunks are word-aligned
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
