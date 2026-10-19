// AudioWorkletProcessor "player": gapless queue of float chunks (already at the context rate), each tagged with a
// segment instance id. Reports the context frame of the first non-silent sample rendered for each id.
// Runs in AudioWorkletGlobalScope; loaded via `?worker&url` (see context.ts). Kept dependency-free.
//
// Messages in:  {type:"push", id, samples: Float32Array} | {type:"reset"} | {type:"drop", ids}  (cut off: fade out
//               what's playing of those segment instances and drop the rest of them)
// Messages out: {type:"played", id, frame}   — frame = context frame index of that sample

declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

/** Keep in sync with SILENCE_THRESHOLD in dsp.ts (not imported to keep this worklet standalone). */
const THRESHOLD = 1 / 1000;
/** A cut-off segment fades out over this many seconds (no click). */
const FADE_S = 0.025;
declare const sampleRate: number;

interface Chunk { id: number; samples: Float32Array; pos: number }

class PlayerProcessor extends AudioWorkletProcessor {
  private queue: Chunk[] = [];
  private reported = new Set<number>();

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<{ type: "push"; id: number; samples: Float32Array } | { type: "reset" } | { type: "drop"; ids: number[] }>) => {
      const m = e.data;
      if (m.type === "push") {
        if (m.samples.length) this.queue.push({ id: m.id, samples: m.samples, pos: 0 });
      } else if (m.type === "drop") {
        this.drop(new Set(m.ids));
      } else {
        this.queue = [];
        this.reported.clear();
      }
    };
  }

  /** Drop those instances' audio; if one is playing, a short fade of what's next of it stands in for the rest. */
  private drop(ids: Set<number>): void {
    const head = this.queue[0];
    let fade: Chunk | null = null;
    if (head && ids.has(head.id) && head.pos > 0) {
      const n = Math.min(Math.round(FADE_S * sampleRate), head.samples.length - head.pos);
      const samples = head.samples.slice(head.pos, head.pos + n);
      for (let k = 0; k < n; k++) samples[k]! *= 1 - k / n;
      fade = { id: -1, samples, pos: 0 }; // -1: never reported as played
    }
    this.queue = this.queue.filter((c) => !ids.has(c.id));
    if (fade) this.queue.unshift(fade);
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
