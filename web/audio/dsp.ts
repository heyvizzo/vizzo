// Pure DSP helpers shared by the capture worklet, the player and replay. No DOM / Web Audio APIs here,
// so everything is unit-testable in Node and importable from an AudioWorkletGlobalScope.

export const RATE = 24_000;
/** 20 ms at 24 kHz. */
export const FRAME_SAMPLES = 480;
/** First "non-silent" sample: |x| above about −60 dBFS (≈ 33 in PCM16). Shared by player + audio-test. */
export const SILENCE_THRESHOLD = 1 / 1000;

// ── PCM conversion ──────────────────────────────────────────────────────────

export function floatToPcm16(input: Float32Array, out = new Int16Array(input.length)): Int16Array<ArrayBuffer> {
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out as Int16Array<ArrayBuffer>;
}

export function pcm16ToFloat(input: Int16Array, out = new Float32Array(input.length)): Float32Array<ArrayBuffer> {
  for (let i = 0; i < input.length; i++) out[i] = input[i]! / 0x8000;
  return out as Float32Array<ArrayBuffer>;
}

/** PCM16 LE bytes (e.g. a WS binary frame) → Int16Array. Copies if the buffer is unaligned/odd or the host is big-endian. */
export function bytesToPcm16(buf: ArrayBuffer): Int16Array<ArrayBuffer> {
  const n = buf.byteLength >> 1;
  if (LITTLE_ENDIAN) return new Int16Array(buf, 0, n);
  const dv = new DataView(buf);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true);
  return out;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Average all channels into one. */
export function downmix(channels: readonly Float32Array[], out?: Float32Array): Float32Array {
  const first = channels[0];
  if (!first) return out ?? new Float32Array(0);
  const n = first.length;
  const dst = out && out.length === n ? out : new Float32Array(n);
  if (channels.length === 1) {
    dst.set(first);
    return dst;
  }
  dst.fill(0);
  for (const ch of channels) for (let i = 0; i < n; i++) dst[i]! += ch[i]!;
  const k = 1 / channels.length;
  for (let i = 0; i < n; i++) dst[i]! *= k;
  return dst;
}

/** Index of the first sample with |x| > threshold, or −1. Works on float (−1..1) or PCM16 (scaled) data. */
export function firstNonSilent(samples: Float32Array | Int16Array, threshold = SILENCE_THRESHOLD): number {
  const t = samples instanceof Int16Array ? threshold * 0x8000 : threshold;
  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]!) > t) return i;
  return -1;
}

// ── Resampling ──────────────────────────────────────────────────────────────

/**
 * Streaming windowed-sinc resampler (Blackman window, `halfTaps` taps each side, cutoff at 0.95 × the lower Nyquist).
 * Output sample j sits at input position j × inRate/outRate, with input index 0 = the first sample ever pushed,
 * so timing is preserved exactly: output sample j corresponds to time j/outRate after the first input sample.
 * Output lags input by `halfTaps` input samples (needs future samples); `flush()` drains the tail.
 * Equal rates pass through unchanged.
 */
export class Resampler {
  private readonly ratio: number; // input samples per output sample
  /** Kernel h(|t|) sampled at KERNEL_RES points per input sample, t ∈ [0, halfTaps]. */
  private readonly kernel: Float32Array;
  private readonly passthrough: boolean;
  private buf: Float32Array<ArrayBuffer>;
  private bufLen = 0;
  /** Absolute input index of buf[0]. Starts negative: zero history before the first sample. */
  private bufStart: number;
  private outIndex = 0;
  private inCount = 0;

  constructor(readonly inRate: number, readonly outRate: number, private readonly halfTaps = 16) {
    if (!(inRate > 0 && outRate > 0)) throw new Error(`bad rates ${inRate} → ${outRate}`);
    this.ratio = inRate / outRate;
    const twoFc = Math.min(1, outRate / inRate) * 0.95; // 2 × cutoff (cycles per input sample)
    this.kernel = new Float32Array(halfTaps * KERNEL_RES + 2);
    for (let i = 0; i < this.kernel.length; i++) {
      const t = i / KERNEL_RES;
      this.kernel[i] = twoFc * sinc(twoFc * t) * blackman(t / halfTaps);
    }
    this.passthrough = inRate === outRate;
    this.buf = new Float32Array(4096);
    this.bufStart = -halfTaps;
    this.bufLen = halfTaps; // zeros
  }

  /** Total output samples produced so far. */
  get produced(): number {
    return this.outIndex;
  }

  process(input: Float32Array): Float32Array<ArrayBuffer> {
    if (this.passthrough) {
      this.outIndex += input.length;
      this.inCount += input.length;
      return Float32Array.from(input);
    }
    this.append(input);
    this.inCount += input.length;
    return this.drain(this.bufStart + this.bufLen);
  }

  /** Emit the remaining output (as if the input were followed by silence), up to round(totalIn × outRate/inRate). */
  flush(): Float32Array<ArrayBuffer> {
    if (this.passthrough) return new Float32Array(0);
    const target = Math.round((this.inCount * this.outRate) / this.inRate);
    const before = this.outIndex;
    this.append(new Float32Array(this.halfTaps + 2));
    const out = this.drain(this.bufStart + this.bufLen);
    const keep = Math.max(0, Math.min(out.length, target - before));
    this.outIndex = before + keep;
    return out.slice(0, keep);
  }

  reset(): void {
    this.bufStart = -this.halfTaps;
    this.bufLen = this.halfTaps;
    this.buf.fill(0, 0, this.halfTaps);
    this.outIndex = 0;
    this.inCount = 0;
  }

  private append(input: Float32Array): void {
    if (this.bufLen + input.length > this.buf.length) {
      const next = new Float32Array(Math.max(this.buf.length * 2, this.bufLen + input.length));
      next.set(this.buf.subarray(0, this.bufLen));
      this.buf = next;
    }
    this.buf.set(input, this.bufLen);
    this.bufLen += input.length;
  }

  /** Produce every output whose kernel support lies inside [bufStart, available). */
  private drain(available: number): Float32Array<ArrayBuffer> {
    const N = this.halfTaps;
    const K = this.kernel;
    const maxOut = Math.max(0, Math.ceil((available - N - Math.floor(this.outIndex * this.ratio)) / this.ratio) + 1);
    const out = new Float32Array(maxOut);
    let n = 0;
    for (;;) {
      const p = this.outIndex * this.ratio;
      const base = Math.floor(p);
      if (base + N >= available) break;
      let acc = 0;
      let wsum = 0;
      for (let k = base - N + 1; k <= base + N; k++) {
        const x = Math.abs(p - k) * KERNEL_RES;
        const i0 = Math.floor(x);
        const w = K[i0]! + (K[i0 + 1]! - K[i0]!) * (x - i0);
        acc += this.buf[k - this.bufStart]! * w;
        wsum += w;
      }
      if (n === out.length) break; // defensive; maxOut is an upper bound
      out[n++] = wsum !== 0 ? acc / wsum : 0;
      this.outIndex++;
    }
    // Drop input no longer needed by future outputs.
    const keepFrom = Math.floor(this.outIndex * this.ratio) - N + 1;
    const drop = Math.max(0, Math.min(this.bufLen, keepFrom - this.bufStart));
    if (drop > 0) {
      this.buf.copyWithin(0, drop, this.bufLen);
      this.bufLen -= drop;
      this.bufStart += drop;
    }
    return n === out.length ? out : out.slice(0, n);
  }
}

const KERNEL_RES = 256;

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/** Blackman window over t ∈ [−1, 1]. */
function blackman(t: number): number {
  if (t <= -1 || t >= 1) return 0;
  const x = (t + 1) / 2; // 0..1
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x);
}

/** One-shot resample of a whole buffer. Output length = round(len × outRate/inRate). */
export function resample(input: Float32Array, inRate: number, outRate: number): Float32Array<ArrayBuffer> {
  if (inRate === outRate) return Float32Array.from(input);
  const r = new Resampler(inRate, outRate);
  const a = r.process(input);
  const b = r.flush();
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// ── Framing ─────────────────────────────────────────────────────────────────

/** Accumulates float samples and emits fixed-size PCM16 frames. */
export class Framer {
  private pending: Float32Array;
  private fill = 0;

  constructor(readonly frameSize = FRAME_SAMPLES) {
    this.pending = new Float32Array(frameSize);
  }

  push(samples: Float32Array, emit: (frame: Int16Array<ArrayBuffer>) => void): void {
    let i = 0;
    while (i < samples.length) {
      const n = Math.min(this.frameSize - this.fill, samples.length - i);
      this.pending.set(samples.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      if (this.fill === this.frameSize) {
        emit(floatToPcm16(this.pending));
        this.fill = 0;
      }
    }
  }

  /** Emit the partial frame zero-padded to full size (if any). */
  flush(emit: (frame: Int16Array<ArrayBuffer>) => void): void {
    if (this.fill === 0) return;
    this.pending.fill(0, this.fill);
    emit(floatToPcm16(this.pending));
    this.fill = 0;
  }

  reset(): void {
    this.fill = 0;
  }
}

/** Split a whole 24 kHz mono buffer into 20 ms PCM16 frames (last one zero-padded). */
export function toFrames(samples: Float32Array, frameSize = FRAME_SAMPLES): Int16Array<ArrayBuffer>[] {
  const frames: Int16Array<ArrayBuffer>[] = [];
  const f = new Framer(frameSize);
  f.push(samples, (fr) => frames.push(fr));
  f.flush((fr) => frames.push(fr));
  return frames;
}
