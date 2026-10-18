// Wires the always-listen checkbox, the level graph, and the gate. The chat page decides
// what a start or stop means (open a turn, send it); this only watches the microphone.
import { attackMs, clampHangMs, createVad, disarmVad, stepVad, type Vad } from "../audio/vad.ts";
import { openLevelTap, type LevelTap } from "../audio/level.ts";
import { mountLevelMeter, type LevelMeter } from "./meter.ts";

export interface AlwaysListenHandle {
  setAudioReady(ready: boolean): void;
  /** A held Shift or button owns the turn: silence must not send it. */
  setManualHold(held: boolean): void;
  /** Forget an open gate (Shift, Esc, the button, a failed turn) until the level falls. */
  disarm(): void;
}

export function mountAlwaysListen(opts: {
  checkbox: HTMLInputElement;
  canvas: HTMLCanvasElement;
  caption: HTMLElement;
  /** The "Send after … s of quiet" box (seconds). Shown with the meter. */
  hangInput: HTMLInputElement;
  hangRow: HTMLElement;
  enabled: boolean;
  threshold: number;
  /** How long the level must stay under the line before the turn is sent. */
  hangMs: number;
  /** A reply is being thought or spoken, so a new cross has to last longer. */
  turnInFlight: () => boolean;
  onEnabled: (on: boolean) => void;
  onThreshold: (rms: number) => void;
  onHangMs: (ms: number) => void;
  onStart: () => void;
  /** Silence ended the turn. `speechMs` is how long the level stayed over the line. */
  onStop: (speechMs: number) => void;
  onTapError: (err: unknown) => void;
  /** Each level the tap reads (the Electron toolbar draws its own small meter from these). */
  onLevel?: (rms: number) => void;
}): AlwaysListenHandle {
  const checkbox = opts.checkbox;
  const canvas = opts.canvas;
  const caption = opts.caption;
  let enabled = opts.enabled;
  let threshold = opts.threshold;
  let hangMs = clampHangMs(opts.hangMs);
  const hangInput = opts.hangInput;
  const showHang = () => { hangInput.value = String(hangMs / 1000); };
  showHang();
  hangInput.addEventListener("change", () => {
    const sec = Number.parseFloat(hangInput.value);
    if (Number.isFinite(sec)) {
      hangMs = clampHangMs(sec * 1000);
      opts.onHangMs(hangMs);
      armHang(); // an open hang uses the new length right away
    }
    showHang();
  });
  let audioReady = false;
  let manualHold = false;
  let generation = 0;
  let starting = false;
  let tap: LevelTap | null = null;
  let hangTimer: ReturnType<typeof setTimeout> | null = null;
  let lastLevel = 0;
  /** Time the level has spent over the line since this turn opened (pauses under the line are not counted). */
  let speechMs = 0;
  let aboveSince: number | null = null;
  const vad: Vad = createVad();

  const noteOpen = (now: number) => { aboveSince ??= now; };
  const noteDrop = (now: number) => {
    if (aboveSince === null) return;
    speechMs += Math.max(0, now - aboveSince);
    aboveSince = null;
  };
  const takeSpeech = (now: number) => {
    noteDrop(now);
    const ms = speechMs;
    speechMs = 0;
    return ms;
  };

  const meter: LevelMeter = mountLevelMeter(canvas, {
    threshold,
    onThreshold: (rms) => {
      threshold = rms;
      opts.onThreshold(rms);
    },
  });

  const clearHang = () => {
    if (hangTimer !== null) clearTimeout(hangTimer);
    hangTimer = null;
  };

  const paint = () => meter.setLive(vad.phase !== "idle");

  // rAF pauses in a background window, which would hold a turn open. The hang also
  // has its own timer, using the last level we actually heard.
  const armHang = () => {
    clearHang();
    if (vad.phase !== "hang" || vad.since === null) return;
    const wait = Math.max(0, hangMs - (performance.now() - vad.since));
    hangTimer = setTimeout(() => {
      hangTimer = null;
      if (manualHold || !enabled || vad.phase !== "hang") return;
      const edge = stepVad(vad, lastLevel, threshold, performance.now(), hangMs);
      paint();
      if (edge === "stop") opts.onStop(takeSpeech(performance.now()));
      else if (vad.phase === "hang") armHang();
    }, wait);
  };

  const disarm = () => {
    clearHang();
    disarmVad(vad);
    speechMs = 0;
    aboveSince = null;
    paint();
  };

  const onLevel = (rms: number) => {
    lastLevel = rms;
    meter.push(rms);
    opts.onLevel?.(rms);
    if (!enabled || manualHold) {
      meter.setLive(false);
      return;
    }
    const prev = vad.phase;
    const now = performance.now();
    const edge = stepVad(vad, rms, threshold, now, hangMs, attackMs(opts.turnInFlight()));
    if (edge === "start") noteOpen(now);
    if (vad.phase === "hang" && prev === "open") noteDrop(now);
    if (vad.phase === "open" && prev === "hang") noteOpen(now);
    if (vad.phase === "hang" && prev !== "hang") armHang();
    if (vad.phase !== "hang") clearHang();
    if (edge === "start") opts.onStart();
    else if (edge === "stop") opts.onStop(takeSpeech(now));
    paint();
  };

  const stopTap = () => {
    generation++;
    starting = false;
    tap?.stop();
    tap = null;
    clearHang();
  };

  async function ensureTap(): Promise<void> {
    if (!enabled || !audioReady || tap || starting) return;
    starting = true;
    const my = generation;
    let opened: LevelTap | undefined;
    try {
      opened = await openLevelTap((rms) => {
        if (my !== generation) return;
        onLevel(rms);
      });
    } catch (err) {
      if (my === generation) opts.onTapError(err);
      return;
    } finally {
      if (my === generation) starting = false;
    }
    if (my !== generation || !opened) {
      opened?.stop();
      return;
    }
    tap = opened;
  }

  const applyEnabled = (on: boolean, fromUser: boolean) => {
    enabled = on;
    checkbox.checked = on;
    canvas.hidden = !on;
    caption.hidden = !on;
    opts.hangRow.hidden = !on;
    canvas.tabIndex = on ? 0 : -1;
    if (on) {
      meter.redraw();
      void ensureTap();
      return;
    }
    const hot = vad.phase !== "idle";
    stopTap();
    disarm();
    if (fromUser && hot) opts.onStop(takeSpeech(performance.now()));
  };

  checkbox.addEventListener("change", () => {
    applyEnabled(checkbox.checked, true);
    opts.onEnabled(checkbox.checked);
  });
  applyEnabled(enabled, false);

  return {
    setAudioReady(ready) {
      audioReady = ready;
      if (ready && enabled) void ensureTap();
      if (!ready) stopTap();
    },
    setManualHold(held) {
      manualHold = held;
      if (held) disarm();
    },
    disarm,
  };
}
