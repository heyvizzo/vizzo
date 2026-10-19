// The conversation orb's drawing: the "Plasma Orb" (a React component on @paper-design/shaders-react, ported here to
// plain DOM on @paper-design/shaders). A sphere of flowing mesh gradient (WebGL), with a glow that swells when it
// listens, the plasma churning faster as it speaks, a beat while thinking, and a shake on an error. One animation
// loop drives the shader's clock and uniforms, paused while off screen or the page is hidden; with reduced motion the
// plasma holds still. Without WebGL it's a CSS gradient in the same colours.
//
// Colours: two (from, to) make a five-stop palette as in the original; more (colors.ts ORB_COLORS: six) are used as
// they are. Palette changes ease in over a few frames.

import { meshGradientFragmentShader, ShaderMount, type ShaderMountUniforms } from "@paper-design/shaders";
import { ORB_COLORS, STATE_COLORS } from "./colors.ts";
import { atStops, hexToRgb, mixHex, mixRgb, resample, rgbToHex, type Rgb } from "./orbColor.ts";

export type PlasmaState = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error" | "disabled";

export interface PlasmaOrbOptions {
  state?: PlasmaState;
  /** The sphere's width and height in px; its glow spreads about a third of that beyond. */
  size?: number;
  speed?: number;
  /** Two stops (from, to) or more, up to ten. */
  colors?: readonly string[];
}

export interface PlasmaOrb {
  /** The orb; append it where it goes. */
  el: HTMLElement;
  setState(state: PlasmaState): void;
  setColors(colors: readonly string[]): void;
  destroy(): void;
}

/** Every palette is resampled to this many stops, so one can ease into another. */
const STOPS = 6;
const BASE_FRAME = 8000;
const STATIC_PHASE = 0.9;
const MAX_PIXEL_RATIO = 2;
const MAX_FRAME_DT = 0.1;
const LEVEL_ATTACK_RATE = 14;
const LEVEL_RELEASE_RATE = 4;
const ENTER_RATE = 14;
const SETTLE_RATE = 5;
const ERROR_RATE = 10;
const COLOR_RATE = 8;
const TAU = Math.PI * 2;
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const GL_ATTRIBUTES: WebGLContextAttributes = { antialias: false, powerPreference: "low-power" };

const brandPalette = (from: string, to: string): string[] =>
  [mixHex(from, "#000000", 0.35), from, mixHex(from, to, 0.5), to, mixHex(to, "#ffffff", 0.35)];
const palette = (colors: readonly string[]): Rgb[] => {
  const stops = colors.length === 0 ? ["#ffffff", "#ffffff"] : colors.length <= 2 ? brandPalette(colors[0]!, colors[colors.length - 1]!) : colors;
  return resample(stops, STOPS).map(hexToRgb);
};
const ERROR_PALETTE = palette([STATE_COLORS.failed.from, STATE_COLORS.failed.to]);

// ── state blending ──

const STATE_KEYS: PlasmaState[] = ["idle", "connecting", "listening", "thinking", "speaking", "error", "disabled"];
type Weights = Record<PlasmaState, number>;
const wave = (x: number): number => 0.5 - 0.5 * Math.cos(x);
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const approach = (current: number, target: number, rate: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

function stateEnergy(state: PlasmaState, t: number): number {
  switch (state) {
    case "listening": return 0.4 + 0.32 * wave(t * 17) + 0.18 * wave(t * 8.2 + 3);
    case "speaking": return 0.3 + 0.24 * wave(t * 12.4) + 0.16 * wave(t * 6 + 1.2);
    case "thinking": return 0.24 + 0.2 * wave(t * 4.8);
    case "connecting": return 0.12 + 0.1 * wave(t * 3.2);
    case "error": return 0.2;
    default: return 0;
  }
}
const blendEnergy = (w: Weights, t: number): number => STATE_KEYS.reduce((sum, k) => (w[k] > 0 ? sum + w[k] * stateEnergy(k, t) : sum), 0);
const stateRate = (state: PlasmaState): number => (state === "idle" || state === "disabled" ? SETTLE_RATE : state === "error" ? ERROR_RATE : ENTER_RATE);

/** Eases the weights toward `state` (1) and the rest (0), keeping them summing to 1. */
function updateWeights(w: Weights, state: PlasmaState, dt: number): void {
  let total = 0;
  const rate = stateRate(state);
  for (const k of STATE_KEYS) {
    const target = k === state ? 1 : 0;
    const next = approach(w[k], target, rate, dt);
    w[k] = target === 0 && next < 0.001 ? 0 : next;
    total += w[k];
  }
  if (total > 0) for (const k of STATE_KEYS) w[k] /= total;
}

type Tune = { flow: number; distortion: number; swirl: number; grain: number; outer: number; inner: number; beat: number; beatRate: number; error: number };

const TUNE: Record<PlasmaState, Tune> = {
  idle: { flow: 0.3, distortion: 0.42, swirl: 0.26, grain: 0.06, outer: 0.2, inner: 0.2, beat: 0, beatRate: 0.3, error: 0 },
  connecting: { flow: 0.4, distortion: 0.4, swirl: 0.4, grain: 0.08, outer: 0.1, inner: 0.1, beat: 0.6, beatRate: 0.28, error: 0 },
  listening: { flow: 0.6, distortion: 0.44, swirl: 0.22, grain: 0.12, outer: 1, inner: 0.15, beat: 0, beatRate: 0.3, error: 0 },
  thinking: { flow: 0.7, distortion: 0.35, swirl: 0.78, grain: 0.1, outer: 0.1, inner: 0.1, beat: 1, beatRate: 0.5, error: 0 },
  speaking: { flow: 1.2, distortion: 0.55, swirl: 0.34, grain: 0.18, outer: 0.3, inner: 1, beat: 0, beatRate: 0.3, error: 0 },
  error: { flow: 1.7, distortion: 0.85, swirl: 0.55, grain: 0.2, outer: 0.2, inner: 0.2, beat: 0, beatRate: 0.3, error: 1 },
  disabled: { flow: 0, distortion: 0.4, swirl: 0.2, grain: 0.04, outer: 0, inner: 0, beat: 0, beatRate: 0.3, error: 0 },
};

function blendTune(w: Weights): Tune {
  const out = { flow: 0, distortion: 0, swirl: 0, grain: 0, outer: 0, inner: 0, beat: 0, beatRate: 0, error: 0 };
  for (const k of STATE_KEYS) {
    if (w[k] === 0) continue;
    for (const p of Object.keys(out) as (keyof Tune)[]) out[p] += TUNE[k][p] * w[k];
  }
  return out;
}

// ── styles ──

/** The orb's stylesheet; put it beside the orb (the page overlay adds it to its shadow root). */
export const PLASMA_ORB_CSS = `
.pl { --pl-size: 160px; --pl-level: 0; --pl-outer: 0; position: relative; width: var(--pl-size); height: var(--pl-size); border-radius: 50%;
  scale: calc(1 + var(--pl-outer) * .07); transition: opacity .6s ease-out, filter .6s ease-out; }
.pl[data-state="disabled"] { opacity: .5; filter: grayscale(.85); }
.pl > div, .pl-sphere > div { position: absolute; inset: 0; border-radius: 50%; pointer-events: none; }
.pl-glow { box-shadow:
    0 calc(var(--pl-size) * -.06) calc(var(--pl-size) * .3) calc(var(--pl-outer) * var(--pl-size) * .05) color-mix(in oklab, var(--pl-from) 55%, transparent),
    0 calc(var(--pl-size) * .06) calc(var(--pl-size) * .3) calc(var(--pl-outer) * var(--pl-size) * .05) color-mix(in oklab, var(--pl-to) 55%, transparent);
  opacity: calc(.35 + var(--pl-outer) * .6 + var(--pl-level) * .05); }
.pl-sphere { overflow: hidden; box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--pl-from) 45%, transparent), 0 0 0 1px rgba(255,255,255,.08); }
/* The shader's canvas (Paper's own stylesheet goes to the page's head, which doesn't reach a shadow root). */
.pl-shader { isolation: isolate; }
.pl-shader canvas { contain: strict; display: block; position: absolute; inset: 0; z-index: -1; width: 100%; height: 100%; border-radius: inherit; }
.pl-shine { background-image: radial-gradient(circle at 31% 22%, rgba(255,255,255,.55), transparent 14%), radial-gradient(circle at 30% 26%, rgba(255,255,255,.28), transparent 48%),
  radial-gradient(circle at 68% 76%, rgba(10,14,24,.42), transparent 60%); }
`;

const div = (cls: string, ...children: HTMLElement[]): HTMLDivElement => {
  const el = document.createElement("div");
  el.className = cls;
  el.append(...children);
  return el;
};

const toShaderColor = ([r, g, b]: Rgb): number[] => [r / 255, g / 255, b / 255, 1];

export function mountPlasmaOrb({ state: initial = "idle", size = 160, speed = 1, colors: initialColors = ORB_COLORS }: PlasmaOrbOptions = {}): PlasmaOrb {
  const shaderHost = div("pl-shader");
  const sphere = div("pl-sphere", shaderHost, div("pl-shine"));
  const el = div("pl", div("pl-glow"), sphere);
  el.setAttribute("aria-hidden", "true");
  el.dataset.state = initial;
  el.style.setProperty("--pl-size", `${size}px`);

  let target = palette(initialColors);
  const live: Rgb[] = target.map((c) => [...c] as Rgb);
  const tune0 = TUNE[initial];

  let mount: ShaderMount | null = null;
  try {
    const uniforms: ShaderMountUniforms = {
      u_colors: live.map(toShaderColor), u_colorsCount: STOPS,
      u_distortion: tune0.distortion, u_swirl: tune0.swirl, u_grainMixer: tune0.grain, u_grainOverlay: 0.05,
      u_fit: 0, u_scale: 1.15, u_rotation: 0, u_originX: 0.5, u_originY: 0.5, u_offsetX: 0, u_offsetY: 0, u_worldWidth: 0, u_worldHeight: 0,
    };
    mount = new ShaderMount(shaderHost, meshGradientFragmentShader, uniforms, GL_ATTRIBUTES, 0, BASE_FRAME, 1, size * size * MAX_PIXEL_RATIO * MAX_PIXEL_RATIO);
  } catch {
    mount = null; // no WebGL: the CSS gradient below stands in
  }

  let state = initial;
  const weights = Object.fromEntries(STATE_KEYS.map((k) => [k, k === initial ? 1 : 0])) as Weights;
  let level = 0;
  let phase = 0;
  let shaderClock = 0;
  let beat = 0;
  let paintedKey = "";
  let raf = 0;
  let last: number | null = null;
  let inView = true;
  let pageVisible = document.visibilityState === "visible";
  const mq = window.matchMedia(REDUCED_MOTION);
  let reduced = mq.matches;
  const active = () => inView && pageVisible;

  function tick(now: number): void {
    raf = 0;
    const dt = last === null ? 0 : Math.min((now - last) / 1000, MAX_FRAME_DT);
    last = now;
    updateWeights(weights, state, dt);
    const step = reduced ? 0 : dt * Math.max(0, speed);
    phase += step;
    const tune = blendTune(weights);
    const energy = blendEnergy(weights, reduced ? STATIC_PHASE : phase);
    level = reduced ? energy : approach(level, energy, energy > level ? LEVEL_ATTACK_RATE : LEVEL_RELEASE_RATE, dt);
    beat += step * tune.beatRate;
    const pulse = reduced ? 0.5 : wave(beat * TAU);
    const inner = level * tune.inner + pulse * tune.beat * 0.4;
    const outer = level * tune.outer + pulse * tune.beat * 0.3;
    shaderClock += step * (tune.flow + inner * 0.9);

    // The palette eases toward its target, then toward rose as far as the error look is blended in.
    const ease = 1 - Math.exp(-COLOR_RATE * dt);
    let moving = false;
    for (let i = 0; i < STOPS; i += 1) {
      const c = live[i]!, t = target[i]!;
      for (let ch = 0; ch < 3; ch += 1) {
        const v = c[ch]! + (t[ch]! - c[ch]!) * ease;
        c[ch] = v;
        if (Math.abs(t[ch]! - v) > 0.5) moving = true;
      }
    }
    const err = clamp01(tune.error);
    const shown = err > 0 ? live.map((c, i) => mixRgb(c, ERROR_PALETTE[i]!, err)) : live;

    const key = shown.map(rgbToHex).join("");
    if (key !== paintedKey) {
      paintedKey = key;
      el.style.setProperty("--pl-from", rgbToHex(atStops(shown, 0.25)));
      el.style.setProperty("--pl-to", rgbToHex(atStops(shown, 0.75)));
      if (!mount) {
        const hex = shown.map(rgbToHex);
        sphere.style.background = `radial-gradient(circle at 50% 40%, ${mixHex(hex[1]!, "#ffffff", 0.12)}, ${hex[2]} 30%, ${hex[3]} 60%, ${mixHex(hex[4]!, "#000000", 0.35)} 100%)`;
      }
    }
    el.style.setProperty("--pl-level", level.toFixed(4));
    el.style.setProperty("--pl-outer", clamp01(outer).toFixed(4));
    if (mount) {
      // The shader's own clock is stopped (speed 0); its frame is set here so the flow speeds up and slows down smoothly.
      (mount as unknown as { currentFrame: number }).currentFrame = BASE_FRAME + shaderClock * 1000;
      mount.setUniforms({
        u_colors: shown.map(toShaderColor),
        u_distortion: clamp01(tune.distortion + inner * 0.4),
        u_swirl: clamp01(tune.swirl + inner * 0.15 + pulse * tune.beat * 0.15),
        u_grainMixer: tune.grain,
      });
    }
    // With reduced motion it stops once the state and colours have settled; otherwise the plasma keeps flowing.
    const settled = reduced && weights[state] > 0.999 && !moving;
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
  io?.observe(el);
  const onVisibility = () => { pageVisible = document.visibilityState === "visible"; sync(); };
  document.addEventListener("visibilitychange", onVisibility);
  const onMotion = () => { reduced = mq.matches; wake(); };
  mq.addEventListener("change", onMotion);
  wake();

  let shake: Animation | null = null;
  return {
    el,
    setState(next) {
      if (next === state) return;
      state = next;
      el.dataset.state = next;
      shake?.cancel();
      shake = null;
      if (next === "error" && !reduced && typeof sphere.animate === "function") {
        shake = sphere.animate(
          [{ transform: "translateX(0)" }, { transform: "translateX(-1.5px)" }, { transform: "translateX(3px)" }, { transform: "translateX(-2px)" }, { transform: "translateX(1px)" }, { transform: "translateX(0)" }],
          { duration: 340, easing: "ease-out" },
        );
      }
      wake();
    },
    setColors(next) {
      target = palette(next);
      wake();
    },
    destroy() {
      halt();
      shake?.cancel();
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      mq.removeEventListener("change", onMotion);
      mount?.dispose();
      el.remove();
    },
  };
}
