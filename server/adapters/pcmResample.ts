// Streaming PCM16 mono resampler (linear interpolation) for vendor audio that isn't 24 kHz.
// Chunk boundaries don't matter: the output is the same whether the input arrives whole or in pieces.
// Linear interpolation is enough for speech; it does not low-pass filter before decimating.

export function createPcm16Resampler(inRate: number, outRate: number): (chunk: Buffer) => Buffer {
  if (inRate === outRate) return (chunk) => chunk;
  const step = inRate / outRate; // input samples per output sample
  let samples: number[] = []; // input samples from absolute index `base` on
  let base = 0;
  let k = 0; // next output sample index
  let carry: Buffer | null = null; // odd trailing byte between chunks
  return (chunk) => {
    const data = carry ? Buffer.concat([carry, chunk]) : chunk;
    carry = data.length % 2 ? data.subarray(data.length - 1) : null;
    for (let i = 0; i + 1 < data.length; i += 2) samples.push(data.readInt16LE(i));
    const out: number[] = [];
    for (;;) {
      const t = k * step;
      const i = Math.floor(t);
      if (i + 1 - base >= samples.length) break; // need the next input sample too
      const f = t - i;
      out.push(Math.round(samples[i - base]! * (1 - f) + samples[i + 1 - base]! * f));
      k++;
    }
    const drop = Math.floor(k * step) - base; // inputs before the next output's position are no longer needed
    if (drop > 0) { samples = samples.slice(drop); base += drop; }
    const buf = Buffer.alloc(out.length * 2);
    out.forEach((v, j) => buf.writeInt16LE(v, j * 2));
    return buf;
  };
}
