// Mic → mono → 24 kHz → PCM16 LE frames of 20 ms (480 samples).
// The resampling/framing runs in capture-worklet.ts; this file wires the shared AudioContext + mic stream to it.
import { clockSnapshot, getAudioContext, getMicStream } from "./context.ts";
import { capturePerfTime } from "./timing.ts";

export interface CaptureHandle {
  /** performance.now() of the first captured sample (used as tAudioStart, ARCHITECTURE §6). */
  readonly tAudioStart: Promise<number>;
  stop(): void;
}

export interface CaptureOpts {
  /** Called for every 20 ms PCM16 24 kHz frame. */
  onFrame: (pcm: Int16Array<ArrayBuffer>) => void;
  /** Start this far before now (up to 1 s), from audio the worklet kept while idle. tAudioStart moves back with it. */
  preRollMs?: number;
}

interface Graph {
  ctx: AudioContext;
  node: AudioWorkletNode;
  inputLatency: number;
}

let graphPromise: Promise<Graph> | null = null;
let nextId = 1;
let active: { id: number; stop: () => void } | null = null;

/** Build mic → capture worklet once. The node outputs silence into the destination so it keeps being pulled. */
function getGraph(): Promise<Graph> {
  graphPromise ??= (async () => {
    const [ctx, stream] = await Promise.all([getAudioContext(), getMicStream()]);
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    src.connect(node);
    node.connect(ctx.destination);
    // Chrome reports the capture pipeline latency (s) in the track settings; other browsers: assume 0.
    const settings = stream.getAudioTracks()[0]?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined;
    const inputLatency = typeof settings?.latency === "number" ? settings.latency : 0;
    return { ctx, node, inputLatency };
  })().catch((e) => {
    graphPromise = null;
    throw e;
  });
  return graphPromise;
}

/** Build the capture graph now, so the worklet is already keeping audio for the first turn's pre-roll. */
export async function warmCapture(): Promise<void> {
  await getGraph();
}

/**
 * Starts capturing from the mic. Reuses one AudioContext + mic stream across calls; starting a new capture stops
 * the previous one. After stop() no more onFrame calls happen (a trailing partial frame < 20 ms is dropped).
 *
 * tAudioStart: the worklet reports the context frame of the first sample it received after "start"; we map that
 * context time to performance.now() with ctx.getOutputTimestamp() minus (baseLatency + outputLatency) to get the
 * render time, minus the track's reported input latency to get the capture time (details in timing.ts), clamped to
 * be no later than the moment the worklet's message arrived.
 */
export async function startCapture(opts: CaptureOpts): Promise<CaptureHandle> {
  const { ctx, node, inputLatency } = await getGraph();
  if (ctx.state !== "running") await ctx.resume();
  active?.stop();

  const id = nextId++;
  let stopped = false;
  let resolveStart!: (t: number) => void;
  let rejectStart!: (e: Error) => void;
  const tAudioStart = new Promise<number>((res, rej) => {
    resolveStart = res;
    rejectStart = rej;
  });
  tAudioStart.catch(() => {}); // don't surface as unhandled if the caller never awaits it

  const onMessage = (e: MessageEvent<{ type: string; id: number; frame?: number; sampleRate?: number; pcm?: ArrayBuffer }>) => {
    const m = e.data;
    if (m.id !== id || stopped) return;
    if (m.type === "first") {
      const received = performance.now();
      resolveStart(capturePerfTime(m.frame! / m.sampleRate!, clockSnapshot(ctx), inputLatency, received));
    } else if (m.type === "frame") {
      opts.onFrame(new Int16Array(m.pcm!));
    }
  };
  node.port.addEventListener("message", onMessage);
  node.port.start();
  node.port.postMessage({ type: "start", id, preRollMs: opts.preRollMs ?? 0 });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    node.port.postMessage({ type: "stop", id });
    node.port.removeEventListener("message", onMessage);
    rejectStart(new Error("capture stopped before the first sample"));
    if (active?.id === id) active = null;
  };
  active = { id, stop };
  return { tAudioStart, stop };
}
