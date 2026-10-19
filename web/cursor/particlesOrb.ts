// The conversation orb's drawing: the "Particles Orb" (a React component, ported here to plain DOM). 720 dots on a
// sphere, drawn on a canvas, with a motion per state that the orb blends into over about 0.2 s (0.6 s back to idle):
// listening ripples, thinking pulses, speaking flows and swirls. One animation loop, paused while off screen or the
// page is hidden; with reduced motion it settles and stops.

import { ORB_COLORS, STATE_COLORS } from "./colors.ts";

export type ParticlesState = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error" | "disabled";

export interface ParticlesOrbOptions {
  state?: ParticlesState;
  /** Canvas width and height in px. */
  size?: number;
  speed?: number;
  /** The gradient across the dots, as two or more stops (first to last). */
  colors?: readonly string[];
  /**
   * Dim the dots at sizes under 140 px, as the original does (it's drawn for dark backgrounds). Off, small orbs keep
   * full strength, so they read on light pages too.
   */
  dimSmall?: boolean;
  /** How big each dot is, as a multiple of the original's. */
  dotSize?: number;
}

export interface ParticlesOrb {
  /** The canvas; append it where the orb goes. */
  el: HTMLCanvasElement;
  setState(state: ParticlesState): void;
  setColors(colors: readonly string[]): void;
  destroy(): void;
}

const PARTICLE_COUNT = 720;
const TWO_PI = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const TIME_OFFSET = 1.7;
const TONE_BUCKETS = 12;
const ALPHA_BUCKETS = 10;
const BUCKETS = TONE_BUCKETS * ALPHA_BUCKETS;
const ANGLE_X = 0.32;
const MAX_FRAME_DT = 0.1;
const LEVEL_ATTACK_RATE = 14;
const LEVEL_RELEASE_RATE = 4;
const ENTER_RATE = 14;
const SETTLE_RATE = 5;
const ERROR_RATE = 10;
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

type Rgb = [number, number, number];

const hexToRgb = (hex: string): Rgb => {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? [...clean].map((c) => c + c).join("") : clean;
  const n = Number.parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const ERROR_FROM_RGB = hexToRgb(STATE_COLORS.failed.from);
const ERROR_TO_RGB = hexToRgb(STATE_COLORS.failed.to);

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const approach = (current: number, target: number, rate: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

const toLinear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const toSrgb = (v: number): number => Math.min(255, Math.max(0, (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255));
const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb =>
  [toSrgb(toLinear(a[0]) + (toLinear(b[0]) - toLinear(a[0])) * t), toSrgb(toLinear(a[1]) + (toLinear(b[1]) - toLinear(a[1])) * t), toSrgb(toLinear(a[2]) + (toLinear(b[2]) - toLinear(a[2])) * t)];
/** The colour at `t` (0–1) along evenly spaced stops. */
const atStops = (stops: Rgb[], t: number): Rgb => {
  const x = clamp01(t) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  return mixRgb(stops[i]!, stops[i + 1]!, x - i);
};
const rgb = ([r, g, b]: Rgb): string => `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;

// ── state blending ──

const STATE_KEYS: ParticlesState[] = ["idle", "connecting", "listening", "thinking", "speaking", "error", "disabled"];
type Weights = Record<ParticlesState, number>;

const wave = (x: number): number => 0.5 - 0.5 * Math.cos(x);

/** How lively each state is without live audio. */
function stateEnergy(state: ParticlesState, t: number): number {
  switch (state) {
    case "listening": return 0.4 + 0.32 * wave(t * 17) + 0.18 * wave(t * 8.2 + 3);
    case "speaking": return 0.3 + 0.24 * wave(t * 12.4) + 0.16 * wave(t * 6 + 1.2);
    case "thinking": return 0.24 + 0.2 * wave(t * 4.8);
    case "connecting": return 0.12 + 0.1 * wave(t * 3.2);
    case "error": return 0.2;
    default: return 0;
  }
}

const stateRate = (s: ParticlesState): number => (s === "idle" || s === "disabled" ? SETTLE_RATE : s === "error" ? ERROR_RATE : ENTER_RATE);

/** Eases the weights toward `state` (1) and the rest (0), keeping them summing to 1. */
function updateWeights(w: Weights, state: ParticlesState, dt: number): void {
  const rate = stateRate(state);
  let total = 0;
  for (const k of STATE_KEYS) {
    const target = k === state ? 1 : 0;
    const next = approach(w[k], target, rate, dt);
    w[k] = target === 0 && next < 0.001 ? 0 : next;
    total += w[k];
  }
  if (total > 0) for (const k of STATE_KEYS) w[k] /= total;
}

type Params = {
  tempo: number; spin: number; breathe: number; drift: number; ripple: number; swell: number; flow: number; swirl: number;
  pulse: number; pulseRate: number; ring: number; jitter: number; shake: number; alpha: number; rest: number;
};

// idle's drift is 0.3 here (the original's 1 roughens the outline, each dot wandering by 5% of the radius).
const STATES: Record<ParticlesState, Params> = {
  idle: { tempo: 1, spin: 0.14, breathe: 0.05, drift: 0.3, ripple: 0, swell: 0.04, flow: 0, swirl: 0, pulse: 0, pulseRate: 1, ring: 0, jitter: 0, shake: 0, alpha: 0.72, rest: 0 },
  connecting: { tempo: 1, spin: 0.3, breathe: 0.02, drift: 0.2, ripple: 0, swell: 0, flow: 0, swirl: 0, pulse: 0.06, pulseRate: 0.5, ring: 1, jitter: 0, shake: 0, alpha: 0.8, rest: 0.12 },
  listening: { tempo: 1, spin: 0.55, breathe: 0.012, drift: 0, ripple: 1, swell: 0.12, flow: 0, swirl: 0, pulse: 0, pulseRate: 1, ring: 0, jitter: 0, shake: 0, alpha: 0.92, rest: 0.55 },
  thinking: { tempo: 1, spin: 0.32, breathe: 0.01, drift: 0, ripple: 0, swell: 0, flow: 0, swirl: 0, pulse: 1, pulseRate: 1, ring: 0, jitter: 0, shake: 0, alpha: 0.78, rest: 0.3 },
  speaking: { tempo: 1, spin: 0.24, breathe: 0.01, drift: 0, ripple: 0, swell: 0.06, flow: 1, swirl: 1, pulse: 0, pulseRate: 1, ring: 0, jitter: 0.6, shake: 0, alpha: 0.94, rest: 0.55 },
  error: { tempo: 1, spin: 0.08, breathe: 0, drift: 0, ripple: 0, swell: 0, flow: 0, swirl: 0, pulse: 0, pulseRate: 1, ring: 0, jitter: 0.7, shake: 1, alpha: 0.85, rest: 0.2 },
  disabled: { tempo: 0.04, spin: 0, breathe: 0, drift: 0, ripple: 0, swell: 0, flow: 0, swirl: 0, pulse: 0, pulseRate: 1, ring: 0, jitter: 0, shake: 0, alpha: 0.45, rest: 0 },
};

function blend(w: Weights): Params {
  const out = {} as Record<keyof Params, number>;
  for (const k of STATE_KEYS) {
    if (w[k] === 0) continue;
    const row = STATES[k];
    for (const p of Object.keys(row) as (keyof Params)[]) out[p] = (out[p] ?? 0) + row[p] * w[k];
  }
  return out;
}

// ── the sphere ──

/** Points spread evenly over the unit sphere (a golden-angle spiral), each with its own seed and tone. */
const SPHERE = (() => {
  const n = PARTICLE_COUNT;
  const s = { x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), ringFrac: new Float32Array(n), seed: new Float32Array(n), tone: new Float32Array(n), toneBucket: new Uint8Array(n) };
  for (let i = 0; i < n; i += 1) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = GOLDEN_ANGLE * i;
    const tone = (i * 0.5436890126) % 1;
    s.x[i] = Math.cos(theta) * r;
    s.y[i] = y;
    s.z[i] = Math.sin(theta) * r;
    s.ringFrac[i] = (i * 0.61803398875) % 1;
    s.seed[i] = ((i * 0.7548776662) % 1) * TWO_PI;
    s.tone[i] = tone;
    s.toneBucket[i] = Math.min(TONE_BUCKETS - 1, Math.floor(tone * TONE_BUCKETS));
  }
  return s;
})();

export function mountParticlesOrb({ state: initial = "idle", size = 168, speed = 1, colors: initialColors = ORB_COLORS, dimSmall = true, dotSize = 1 }: ParticlesOrbOptions = {}): ParticlesOrb {
  const canvas = document.createElement("canvas");
  canvas.style.width = canvas.style.height = `${size}px`;
  canvas.setAttribute("aria-hidden", "true");
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = canvas.height = Math.round(size * dpr);

  let state = initial;
  let colors = initialColors.length > 1 ? initialColors : [initialColors[0] ?? "#ffffff", initialColors[0] ?? "#ffffff"];
  const weights = Object.fromEntries(STATE_KEYS.map((k) => [k, k === initial ? 1 : 0])) as Weights;

  const center = size / 2;
  const smallness = Math.min(1, size / 140);
  const dotScale = (0.55 + 0.45 * smallness) * dotSize;
  const alphaScale = dimSmall ? smallness * smallness : 1;
  const baseRadius = center * 0.62;
  const n = PARTICLE_COUNT;
  const px = new Float32Array(n);
  const py = new Float32Array(n);
  const pr = new Float32Array(n);
  const bucketOf = new Uint8Array(n);
  const order = new Uint16Array(n);
  const counts = new Uint16Array(BUCKETS);
  const starts = new Uint16Array(BUCKETS);
  const toneStyles = new Array<string>(TONE_BUCKETS).fill("#fff");

  let paletteKey = "";
  let phase = 0;
  let level = 0;
  let clock = 0;
  let pulseClock = 0;
  let angleY = 0;
  let ringPhase = 0;

  function ensurePalette(errorW: number): void {
    const errKey = Math.round(errorW * 64);
    const key = `${colors.join("|")}|${errKey}`;
    if (key === paletteKey) return;
    paletteKey = key;
    const e = errKey / 64;
    // Each stop eases toward the failed gradient at the same place along it.
    const last = colors.length - 1;
    const stops = colors.map((c, i) => mixRgb(hexToRgb(c), mixRgb(ERROR_FROM_RGB, ERROR_TO_RGB, i / last), e));
    for (let b = 0; b < TONE_BUCKETS; b += 1) toneStyles[b] = rgb(atStops(stops, (b + 0.5) / TONE_BUCKETS));
  }

  function draw(dPhase: number, reduced: boolean): void {
    if (!ctx) return;
    const p = blend(weights);
    const lvl = reduced ? p.rest : level;

    clock += dPhase * p.tempo;
    pulseClock += dPhase * p.tempo * p.pulseRate;
    angleY += dPhase * p.spin * (1 + p.ripple * lvl * 1.8);
    ringPhase = (ringPhase + dPhase * 0.7) % TWO_PI;
    const t = clock + TIME_OFFSET;
    const pt = pulseClock + TIME_OFFSET;

    const beat = Math.sin(pt * 2.6) * 0.5 + 0.5;
    const beatSharp = beat * beat * beat;
    const breathe = p.breathe * Math.sin(t * 1.1);
    const conv = p.pulse * (0.06 + 0.12 * beatSharp);
    const radius = baseRadius * (1 + breathe + lvl * p.swell - conv);

    const shakeAmp = p.shake * radius * 0.05;
    const shakeX = shakeAmp * (Math.sin(t * 26) + 0.5 * Math.sin(t * 15.7));
    const shakeY = shakeAmp * (Math.cos(t * 22.5) + 0.5 * Math.sin(t * 13.1));
    const driftAmp = p.drift * radius * 0.055;
    const jitterAmp = p.jitter * radius * (0.012 + lvl * 0.07);
    const rippleAmp = p.ripple * (0.04 + lvl * 0.22);
    const pulseAmp = p.pulse * 0.16 * (0.4 + 0.6 * beat);
    const flowAmp = p.flow * (0.18 + lvl * 0.4);
    const swirlAmp = p.swirl * (0.35 + lvl * 0.9);
    const ringW = clamp01(p.ring);
    const ringBreath = 1 + p.pulse * 0.4 * Math.sin(pt * 2.6);
    const cosX = Math.cos(ANGLE_X);
    const sinX = Math.sin(ANGLE_X);
    counts.fill(0);

    for (let i = 0; i < n; i += 1) {
      const sx = SPHERE.x[i]!, sy = SPHERE.y[i]!, sz = SPHERE.z[i]!, seed = SPHERE.seed[i]!, ringFrac = SPHERE.ringFrac[i]!;
      const twist = swirlAmp > 0.002 ? angleY + swirlAmp * Math.sin(sy * 2.4 + t * 1.6) : angleY;
      const cy = Math.cos(twist), sny = Math.sin(twist);
      const x1 = sx * cy - sz * sny;
      const z1 = sx * sny + sz * cy;
      const y1 = sy * cosX - z1 * sinX;
      const z2 = sy * sinX + z1 * cosX;
      const depth = (z2 + 1) / 2;
      const perspective = 0.65 + depth * 0.45;

      let pointRadius = radius;
      if (rippleAmp > 0.002) pointRadius *= 1 + rippleAmp * (0.5 + 0.5 * Math.sin(sy * 4.5 - t * 6.5));
      if (pulseAmp > 0.002) pointRadius *= 1 - pulseAmp * (0.5 + 0.5 * Math.sin(ringFrac * TWO_PI + pt * 3.1));
      if (flowAmp > 0.002) {
        const stream = 0.5 + 0.5 * Math.sin(seed * 3 - t * 3.4);
        pointRadius *= 1 - flowAmp * stream * stream;
      }

      let ox = shakeX, oy = shakeY;
      if (driftAmp > 0.01) {
        ox += driftAmp * (Math.sin(t * 0.55 + seed * 3.7) + 0.5 * Math.sin(t * 1.3 + seed * 1.3));
        oy += driftAmp * (Math.cos(t * 0.62 + seed * 2.9) + 0.5 * Math.sin(t * 1.05 + seed * 5.1));
      }
      if (jitterAmp > 0.01) {
        ox += jitterAmp * Math.sin(t * 14 + seed * 9.3);
        oy += jitterAmp * Math.cos(t * 17 + seed * 6.1);
      }

      let screenX = center + x1 * pointRadius * perspective + ox;
      let screenY = center + y1 * pointRadius * perspective + oy;
      let alpha = 0.12 + depth * depth * 0.78;
      let dot = 0.6 + depth * 1.5;

      if (ringW > 0.004) {
        const tone = SPHERE.tone[i]!;
        const ringAngle = (i / n) * TWO_PI + ringPhase + 0.05 * Math.sin(t * 1.3 + seed);
        const ringR = center * (0.58 + 0.13 * ringFrac) * (1 + 0.05 * Math.sin(t + seed * 1.7)) * ringBreath;
        screenX += (center + Math.cos(ringAngle) * ringR - screenX) * ringW;
        screenY += (center + Math.sin(ringAngle) * ringR - screenY) * ringW;
        alpha += (0.35 + tone * 0.5 - alpha) * ringW;
        dot += (0.75 + tone * 0.9 - dot) * ringW;
      }

      px[i] = screenX;
      py[i] = screenY;
      pr[i] = dot * dotScale;
      alpha *= alphaScale;
      const ab = Math.min(ALPHA_BUCKETS - 1, Math.floor(alpha * ALPHA_BUCKETS));
      const b = SPHERE.toneBucket[i]! * ALPHA_BUCKETS + ab;
      bucketOf[i] = b;
      counts[b] = counts[b]! + 1;
    }

    // Draw bucket by bucket (one path per colour and opacity) rather than dot by dot.
    let acc = 0;
    for (let b = 0; b < BUCKETS; b += 1) { starts[b] = acc; acc += counts[b]!; }
    for (let i = 0; i < n; i += 1) { const b = bucketOf[i]!; order[starts[b]!] = i; starts[b] = starts[b]! + 1; }

    ensurePalette(weights.error);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.globalCompositeOperation = "lighter";
    let cursor = 0;
    for (let b = 0; b < BUCKETS; b += 1) {
      const count = counts[b]!;
      if (count === 0) continue;
      const ab = b % ALPHA_BUCKETS;
      ctx.globalAlpha = clamp01(((ab + 0.5) / ALPHA_BUCKETS) * p.alpha);
      ctx.fillStyle = toneStyles[(b - ab) / ALPHA_BUCKETS]!;
      ctx.beginPath();
      for (let k = cursor; k < cursor + count; k += 1) {
        const i = order[k]!;
        ctx.moveTo(px[i]! + pr[i]!, py[i]!);
        ctx.arc(px[i]!, py[i]!, pr[i]!, 0, TWO_PI);
      }
      ctx.fill();
      cursor += count;
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  // ── the loop ──

  const mq = matchMedia(REDUCED_MOTION);
  let reduced = mq.matches;
  let raf = 0;
  let last: number | null = null;
  let inView = true;
  let pageVisible = document.visibilityState === "visible";
  const active = () => inView && pageVisible;

  function tick(now: number): void {
    raf = 0;
    const dt = last === null ? 0 : Math.min((now - last) / 1000, MAX_FRAME_DT);
    last = now;
    updateWeights(weights, state, dt);
    const dPhase = reduced ? 0 : dt * Math.max(0, speed);
    phase += dPhase;
    let energy = 0;
    if (!reduced) for (const k of STATE_KEYS) if (weights[k] > 0) energy += weights[k] * stateEnergy(k, phase);
    level = approach(level, energy, energy > level ? LEVEL_ATTACK_RATE : LEVEL_RELEASE_RATE, dt);
    draw(dPhase, reduced);
    const settled = reduced && weights[state] > 0.999 && level < 0.001;
    if (active() && !settled) raf = requestAnimationFrame(tick);
    else last = null;
  }
  const wake = () => { if (active() && raf === 0) raf = requestAnimationFrame(tick); };
  const halt = () => { if (raf !== 0) cancelAnimationFrame(raf); raf = 0; last = null; };
  const sync = () => (active() ? wake() : halt());

  const io = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
    inView = entries[entries.length - 1]?.isIntersecting ?? true;
    sync();
  });
  io?.observe(canvas);
  const onVisibility = () => { pageVisible = document.visibilityState === "visible"; sync(); };
  document.addEventListener("visibilitychange", onVisibility);
  const onMotion = () => { reduced = mq.matches; wake(); };
  mq.addEventListener("change", onMotion);

  draw(0, reduced);
  wake();

  return {
    el: canvas,
    setState(next) { if (next !== state) { state = next; wake(); } },
    setColors(next) {
      if (next.length < 2 || next.join("|") === colors.join("|")) return;
      colors = next;
      if (raf === 0) draw(0, reduced); // repaint even when settled
    },
    destroy() {
      halt();
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      mq.removeEventListener("change", onMotion);
      canvas.remove();
    },
  };
}
