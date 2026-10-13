// Gapless PCM16 24 kHz playback per segment. Reports the first non-silent sample actually played.
// 24 kHz → context rate resampling happens here (main thread); player-worklet.ts only queues and detects onset.
import type { Segment } from "../../shared/protocol.ts";
import { clockSnapshot, getAudioContext } from "./context.ts";
import { RATE, Resampler, bytesToPcm16, pcm16ToFloat } from "./dsp.ts";
import { outputPerfTime } from "./timing.ts";

export interface Player {
  /** Mark the start of a segment; following push() calls belong to it. */
  startSegment(segment: Segment): void;
  /** Queue PCM16 24 kHz mono LE audio for the current segment. */
  push(pcm: ArrayBuffer): void;
  endSegment(segment: Segment): void;
  /** Called once per segment with the performance.now() time its first non-silent sample was played. */
  onPlayed: ((segment: Segment, tPlayed: number) => void) | null;
  /** Drop queued audio (cancel / new turn). */
  reset(): void;
}

/**
 * Each startSegment() opens a new segment instance (fresh id). Audio pushed before any startSegment() plays but
 * is never reported. Audio pushed after endSegment() still belongs to the last segment (late network frames).
 * tPlayed = getOutputTimestamp()-mapped context time of the onset frame, i.e. when it left the speaker
 * (output latency included, ARCHITECTURE §5).
 */
export async function createPlayer(): Promise<Player> {
  const ctx = await getAudioContext();
  const node = new AudioWorkletNode(ctx, "player", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
  node.connect(ctx.destination);

  let resampler = new Resampler(RATE, ctx.sampleRate);
  let nextId = 0;
  let current: { id: number; segment: Segment } | null = null;
  /** Segment instances of the current epoch still waiting for their onset report. */
  const pending = new Map<number, Segment>();

  const post = (samples: Float32Array<ArrayBuffer>) => {
    if (samples.length) node.port.postMessage({ type: "push", id: current?.id ?? -1, samples }, [samples.buffer]);
  };

  node.port.onmessage = (e: MessageEvent<{ type: "played"; id: number; frame: number }>) => {
    const m = e.data;
    const segment = pending.get(m.id);
    if (m.type !== "played" || segment === undefined) return; // stale (before reset) or unknown
    pending.delete(m.id);
    player.onPlayed?.(segment, outputPerfTime(m.frame / ctx.sampleRate, clockSnapshot(ctx)));
  };

  const player: Player = {
    onPlayed: null,
    startSegment(segment) {
      post(resampler.flush());
      resampler = new Resampler(RATE, ctx.sampleRate);
      current = { id: nextId++, segment };
      pending.set(current.id, segment);
    },
    push(pcm) {
      if (ctx.state !== "running") void ctx.resume();
      post(resampler.process(pcm16ToFloat(bytesToPcm16(pcm))));
    },
    endSegment(segment) {
      if (current?.segment !== segment) return;
      post(resampler.flush());
      resampler = new Resampler(RATE, ctx.sampleRate);
    },
    reset() {
      node.port.postMessage({ type: "reset" });
      resampler = new Resampler(RATE, ctx.sampleRate);
      pending.clear();
      current = null;
    },
  };
  return player;
}
