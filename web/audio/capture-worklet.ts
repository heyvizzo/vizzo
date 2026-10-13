// AudioWorkletProcessor "capture": mic → mono → 24 kHz → PCM16 LE 20 ms frames, posted to the main thread.
// Runs in AudioWorkletGlobalScope; loaded via `?worker&url` (see context.ts).
//
// Messages in:  {type:"start", id} | {type:"stop", id}
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

class CaptureProcessor extends AudioWorkletProcessor {
  private id = -1;
  private active = false;
  private sentFirst = false;
  private readonly resampler = new Resampler(sampleRate, RATE);
  private readonly framer = new Framer(FRAME_SAMPLES);
  private mono: Float32Array = new Float32Array(128);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<{ type: "start" | "stop"; id: number }>) => {
      const m = e.data;
      if (m.type === "start") {
        this.id = m.id;
        this.active = true;
        this.sentFirst = false;
        this.resampler.reset();
        this.framer.reset();
      } else if (m.type === "stop" && m.id === this.id) {
        this.active = false;
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.active) return true;
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true; // no mic data connected yet
    this.mono = downmix(input, this.mono);
    if (!this.sentFirst) {
      this.sentFirst = true;
      // currentFrame = context frame of the first sample in this render quantum = first captured sample of the turn.
      this.port.postMessage({ type: "first", id: this.id, frame: currentFrame, sampleRate });
    }
    const out = this.resampler.process(this.mono);
    this.framer.push(out, (pcm) => {
      const buf = pcm.buffer;
      this.port.postMessage({ type: "frame", id: this.id, pcm: buf }, [buf]);
    });
    return true;
  }
}

registerProcessor("capture", CaptureProcessor);
