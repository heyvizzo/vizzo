// AudioContext time ↔ performance.now() mapping. Pure: callers pass a snapshot of the context's clocks.
//
// Model (Web Audio spec terms):
// - `getOutputTimestamp()` returns {contextTime (s), performanceTime (ms)}: the sample frame at `contextTime`
//   reached the output device at `performanceTime`. So for any context time t, it is *heard* at
//       out(t) = performanceTime + (t − contextTime) × 1000.
//   This already includes the context's processing latency and the device output latency.
// - The render quantum that has currentTime = t is computed roughly `baseLatency + outputLatency` seconds before
//   it is heard. So it is *rendered* at   render(t) ≈ out(t) − (baseLatency + outputLatency) × 1000.
// - Mic input delivered to that render quantum was captured at the microphone `inputLatency` seconds earlier
//   (Chrome exposes it as MediaStreamTrack.getSettings().latency), so the first input sample of the quantum at t
//   was captured at   capture(t) ≈ render(t) − inputLatency × 1000.
// Before audio starts flowing getOutputTimestamp() can return zeros; then we fall back to "currentTime is being
// rendered right now": render(t) ≈ now + (t − currentTime) × 1000.

export interface ClockSnapshot {
  /** ctx.getOutputTimestamp() */
  ts: { contextTime?: number; performanceTime?: number };
  /** ctx.currentTime (s) and performance.now() (ms), read together. */
  currentTime: number;
  now: number;
  /** ctx.baseLatency / ctx.outputLatency (s); 0 if unavailable. */
  baseLatency: number;
  outputLatency: number;
}

const validTs = (s: ClockSnapshot): s is ClockSnapshot & { ts: { contextTime: number; performanceTime: number } } =>
  (s.ts.performanceTime ?? 0) > 0 && (s.ts.contextTime ?? 0) > 0;

/** performance.now() at which the sample at context time `t` (s) is heard at the speaker. */
export function outputPerfTime(t: number, s: ClockSnapshot): number {
  if (validTs(s)) return s.ts.performanceTime + (t - s.ts.contextTime) * 1000;
  return s.now + (t - s.currentTime) * 1000 + (s.baseLatency + s.outputLatency) * 1000;
}

/** performance.now() at which the render quantum at context time `t` (s) was processed. */
export function renderPerfTime(t: number, s: ClockSnapshot): number {
  if (validTs(s)) return outputPerfTime(t, s) - (s.baseLatency + s.outputLatency) * 1000;
  return s.now + (t - s.currentTime) * 1000;
}

/**
 * performance.now() at which the mic sample delivered at context time `t` was captured.
 * `notAfter` (e.g. the time the worklet's message was received) clamps the estimate: a sample can't have been
 * captured after we were told about it.
 */
export function capturePerfTime(t: number, s: ClockSnapshot, inputLatency = 0, notAfter = Infinity): number {
  return Math.min(renderPerfTime(t, s) - inputLatency * 1000, notAfter);
}
