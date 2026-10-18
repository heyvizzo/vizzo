// AudioWorkletProcessor "capture": mic → mono → 24 kHz → PCM16 LE 20 ms frames, posted to the main thread.
// Runs in AudioWorkletGlobalScope; loaded via `?worker&url` (see context.ts).
//
// Messages in:  {type:"start", id, preRollMs?} | {type:"stop", id}
//               preRollMs: start that far back (from the last second of mic audio kept while idle), so words
//               spoken before the always-listen gate opened aren't cut off.
// Messages out: {type:"first", id, frame, sampleRate}   — context frame index of the first captured sample
//               {type:"frame", id, pcm: ArrayBuffer}     — 480 PCM16 samples (transferred)
import { FRAME_SAMPLES, Framer, RATE, Resampler, downmix } from "./dsp.ts";

// AudioWorkletGlobalScope globals (not in lib.dom).
declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

/** How much mic audio the worklet keeps for a pre-roll (seconds). */
const PRE_ROLL_MAX_S = 1;

class CaptureProcessor extends AudioWorkletProcessor {
  private id = -1;
  private active = false;
  private sentFirst = false;
  private readonly resampler = new Resampler(sampleRate, RATE);
  private readonly framer = new Framer(FRAME_SAMPLES);
  private mono: Float32Array = new Float32Array(128);
  /** The last PRE_ROLL_MAX_S of mono input (context rate), oldest at `ringAt`. */
  private readonly ring = new Float32Array(Math.ceil(sampleRate * PRE_ROLL_MAX_S));
  private ringAt = 0;
  private ringLen = 0;
  /** Input samples to replay from the ring when this capture's first quantum arrives. */
  private preRoll = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<{ type: "start" | "stop"; id: number; preRollMs?: number }>) => {
      const m = e.data;
      if (m.type === "start") {
        this.id = m.id;
        this.active = true;
        this.sentFirst = false;
        this.preRoll = Math.round((Math.max(0, m.preRollMs ?? 0) * sampleRate) / 1000);
        this.resampler.reset();
        this.framer.reset();
      } else if (m.type === "stop" && m.id === this.id) {
        this.active = false;
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true; // no mic data connected yet
    this.mono = downmix(input, this.mono);
    if (this.active) {
      if (!this.sentFirst) {
        this.sentFirst = true;
        const n = Math.min(this.preRoll, this.ringLen);
        // currentFrame = context frame of the first sample in this render quantum; the pre-roll starts n frames earlier.
        this.port.postMessage({ type: "first", id: this.id, frame: currentFrame - n, sampleRate });
        if (n) this.emit(this.ringTail(n));
      }
      this.emit(this.mono);
    }
    this.remember(this.mono);
    return true;
  }

  private emit(samples: Float32Array): void {
    const out = this.resampler.process(samples);
    this.framer.push(out, (pcm) => {
      const buf = pcm.buffer;
      this.port.postMessage({ type: "frame", id: this.id, pcm: buf }, [buf]);
    });
  }

  private remember(samples: Float32Array): void {
    const cap = this.ring.length;
    for (let i = 0; i < samples.length; i++) this.ring[(this.ringAt + this.ringLen + i) % cap] = samples[i]!;
    const total = this.ringLen + samples.length;
    if (total > cap) this.ringAt = (this.ringAt + total - cap) % cap;
    this.ringLen = Math.min(total, cap);
  }

  /** The newest n samples, oldest first. */
  private ringTail(n: number): Float32Array {
    const cap = this.ring.length;
    const out = new Float32Array(n);
    const from = this.ringAt + this.ringLen - n;
    for (let i = 0; i < n; i++) out[i] = this.ring[(from + i) % cap]!;
    return out;
  }
}

registerProcessor("capture", CaptureProcessor);
