// Live mic level for the always-listen meter. Separate from capture: the turn's worklet only
// runs while a turn is open, and this tap has to move before any turn starts.
import { rmsOf } from "./dsp.ts";
import { getAudioContext, getMicStream } from "./context.ts";

export interface LevelTap {
  stop(): void;
}

/**
 * Calls `onLevel` with the mic's RMS on each animation frame. The analyser is pulled by a
 * near-silent sink so it keeps rendering without playing the microphone back.
 */
export async function openLevelTap(onLevel: (rms: number) => void): Promise<LevelTap> {
  const [ctx, stream] = await Promise.all([getAudioContext(), getMicStream()]);
  if (ctx.state !== "running") await ctx.resume();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0;
  const sink = ctx.createGain();
  // Inaudible (~−100 dB). A gain of exact 0 is dropped by some engines, which freezes the analyser.
  sink.gain.value = 1e-5;
  src.connect(analyser);
  analyser.connect(sink);
  sink.connect(ctx.destination);

  const buf = new Float32Array(analyser.fftSize);
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    analyser.getFloatTimeDomainData(buf);
    onLevel(rmsOf(buf));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      src.disconnect();
      analyser.disconnect();
      sink.disconnect();
    },
  };
}
