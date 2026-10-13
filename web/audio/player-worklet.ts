// AudioWorkletProcessor "player": gapless queue of float chunks (already at the context rate), each tagged with a
// segment instance id. Reports the context frame of the first non-silent sample rendered for each id.
// Runs in AudioWorkletGlobalScope; loaded via `?worker&url` (see context.ts). Kept dependency-free.
//
// Messages in:  {type:"push", id, samples: Float32Array} | {type:"reset"}
// Messages out: {type:"played", id, frame}   — frame = context frame index of that sample

declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

/** Keep in sync with SILENCE_THRESHOLD in dsp.ts (not imported to keep this worklet standalone). */
const THRESHOLD = 1 / 1000;

interface Chunk { id: number; samples: Float32Array; pos: number }

class PlayerProcessor extends AudioWorkletProcessor {
  private queue: Chunk[] = [];
  private reported = new Set<number>();

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<{ type: "push"; id: number; samples: Float32Array } | { type: "reset" }>) => {
      const m = e.data;
      if (m.type === "push") {
        if (m.samples.length) this.queue.push({ id: m.id, samples: m.samples, pos: 0 });
      } else {
        this.queue = [];
        this.reported.clear();
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const ch0 = out?.[0];
    if (!out || !ch0) return true;
    const n = ch0.length;
    let i = 0;
    while (i < n && this.queue.length) {
      const c = this.queue[0]!;
      const take = Math.min(n - i, c.samples.length - c.pos);
      if (c.id >= 0 && !this.reported.has(c.id)) {
        for (let k = 0; k < take; k++) {
          if (Math.abs(c.samples[c.pos + k]!) > THRESHOLD) {
            this.reported.add(c.id);
            this.port.postMessage({ type: "played", id: c.id, frame: currentFrame + i + k });
            break;
          }
        }
      }
      ch0.set(c.samples.subarray(c.pos, c.pos + take), i);
      i += take;
      c.pos += take;
      if (c.pos >= c.samples.length) this.queue.shift();
    }
    if (i < n) ch0.fill(0, i); // underrun: silence until more audio arrives
    for (let c = 1; c < out.length; c++) out[c]!.set(ch0);
    return true;
  }
}

registerProcessor("player", PlayerProcessor);
