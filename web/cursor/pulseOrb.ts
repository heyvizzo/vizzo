// The conversation orb's drawing: the "Pulse Orb" (a React component, ported here to plain DOM and CSS). A glossy
// core over a soft glow, with rings that emit while idle, listening and speaking, and an arc that spins while
// thinking; an error blinks. CSS does the motion; one animation loop only feeds it a level (how lively the state is),
// paused while off screen or the page is hidden, and settled with reduced motion.
//
// Six colours, in role order (colors.ts ORB_COLORS): the core's highlight, middle and rim (0–2), then the glow and
// rings, light to deep (3–5). The arc sweeps through them all. Two colours spread across the six.

import { ORB_COLORS } from "./colors.ts";

export type PulseState = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error" | "disabled";

export interface PulseOrbOptions {
  state?: PulseState;
  /** Width and height in px; the core is 42% of it, the rings reach out to it. */
  size?: number;
  speed?: number;
  /** Two stops (from, to) or six (see above). */
  colors?: readonly string[];
}

export interface PulseOrb {
  /** The orb; append it where it goes. */
  el: HTMLElement;
  setState(state: PulseState): void;
  setColors(colors: readonly string[]): void;
  destroy(): void;
}

const STOPS = 6;
const MAX_FRAME_DT = 0.1;
const LEVEL_ATTACK_RATE = 14;
const LEVEL_RELEASE_RATE = 4;
const ENTER_RATE = 14;
const SETTLE_RATE = 5;
const ERROR_RATE = 10;
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

// ── colours ──

type Rgb = [number, number, number];
const hexToRgb = (hex: string): Rgb => {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? [...clean].map((c) => c + c).join("") : clean;
  const n = Number.parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toLinear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const toSrgb = (v: number): number => Math.min(255, Math.max(0, (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255));
const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb =>
  [toSrgb(toLinear(a[0]) + (toLinear(b[0]) - toLinear(a[0])) * t), toSrgb(toLinear(a[1]) + (toLinear(b[1]) - toLinear(a[1])) * t), toSrgb(toLinear(a[2]) + (toLinear(b[2]) - toLinear(a[2])) * t)];
const toHex = (c: Rgb): string => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/** Any number of stops (at least one) as the six the orb uses, evenly along the gradient they make. */
export function sixStops(colors: readonly string[]): string[] {
  if (colors.length === STOPS) return [...colors];
  const rgb = colors.length > 0 ? colors.map(hexToRgb) : [[255, 255, 255] as Rgb];
  if (rgb.length === 1) return Array<string>(STOPS).fill(toHex(rgb[0]!));
  return Array.from({ length: STOPS }, (_, i) => {
    const x = (i / (STOPS - 1)) * (rgb.length - 1);
    const j = Math.min(rgb.length - 2, Math.floor(x));
    return toHex(mixRgb(rgb[j]!, rgb[j + 1]!, x - j));
  });
}

// ── level: how lively each state is, blended as the orb moves between them ──

const STATE_KEYS: PulseState[] = ["idle", "connecting", "listening", "thinking", "speaking", "error", "disabled"];
type Weights = Record<PulseState, number>;
const wave = (x: number): number => 0.5 - 0.5 * Math.cos(x);
const approach = (current: number, target: number, rate: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

function stateEnergy(state: PulseState, t: number): number {
  switch (state) {
    case "listening": return 0.4 + 0.32 * wave(t * 17) + 0.18 * wave(t * 8.2 + 3);
    case "speaking": return 0.3 + 0.24 * wave(t * 12.4) + 0.16 * wave(t * 6 + 1.2);
    case "thinking": return 0.24 + 0.2 * wave(t * 4.8);
    case "connecting": return 0.12 + 0.1 * wave(t * 3.2);
    case "error": return 0.2;
    default: return 0;
  }
}

const stateRate = (state: PulseState): number => (state === "idle" || state === "disabled" ? SETTLE_RATE : state === "error" ? ERROR_RATE : ENTER_RATE);

/** Eases the weights toward `state` (1) and the rest (0), keeping them summing to 1. */
function updateWeights(w: Weights, state: PulseState, dt: number): void {
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

// ── styles ──

/**
 * The custom properties that transition (colours fade between states, the breathing and blinking ease in and out).
 * Registered from script because @property doesn't apply inside a shadow root; registration is per document, so
 * repeats throw and are ignored.
 */
const ANIMATED: [string, string, string][] = [
  ...Array.from({ length: STOPS }, (_, i): [string, string, string] => [`--vz-po-c${i}`, "<color>", ORB_COLORS[i] ?? "#ffffff"]),
  ["--vz-po-glow", "<number>", "1"],
  ["--vz-po-breathe-idle", "<number>", "0"],
  ["--vz-po-breathe-think", "<number>", "0"],
  ["--vz-po-blink", "<number>", "0"],
];
let registered = false;
function registerProperties(): void {
  if (registered || typeof CSS === "undefined" || typeof CSS.registerProperty !== "function") return;
  registered = true;
  for (const [name, syntax, initialValue] of ANIMATED) {
    try { CSS.registerProperty({ name, syntax, inherits: true, initialValue }); } catch { /* already registered */ }
  }
}

const NOISE = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23n)'/%3E%3C/svg%3E")`;

/** The orb's stylesheet; put it beside the orb (the page overlay adds it to its shadow root). */
export const PULSE_ORB_CSS = `
.po { --po-size: 160px; --po-speed: 1; --po-level: 0; --po-dur: .2s; --po-ease: cubic-bezier(.16,1,.3,1);
  --vz-po-glow: 1; --vz-po-breathe-idle: 0; --vz-po-breathe-think: 0; --vz-po-blink: 0;
  position: relative; display: grid; place-items: center; width: var(--po-size); height: var(--po-size); isolation: isolate;
  transition-property: opacity, filter, ${ANIMATED.map(([n]) => n).join(", ")};
  transition-duration: var(--po-dur); transition-timing-function: var(--po-ease); }
.po:is([data-state="idle"], [data-state="disabled"]) { --po-dur: .6s; --po-ease: cubic-bezier(.65,0,.35,1); }
.po[data-state="idle"] { --vz-po-breathe-idle: 1; }
.po[data-state="thinking"] { --vz-po-breathe-think: 1; }
.po[data-state="connecting"] { --vz-po-glow: .6; }
.po[data-state="error"] { --vz-po-blink: 1; }
.po[data-state="disabled"] { --vz-po-glow: .4; filter: grayscale(.8); opacity: .5; }
.po > span { pointer-events: none; }

.po-glow { position: absolute; width: 82%; height: 82%; border-radius: 50%;
  background:
    radial-gradient(48% 48% at 36% 32%, color-mix(in oklab, var(--vz-po-c3), transparent 20%), transparent 70%),
    radial-gradient(52% 52% at 66% 70%, color-mix(in oklab, var(--vz-po-c4), transparent 26%), transparent 72%);
  filter: blur(18px); opacity: calc(var(--vz-po-glow) * (.5 + .5 * var(--po-level))); transform: scale(calc(.95 + .22 * var(--po-level)));
  will-change: transform, opacity; }

.po-core-shell { position: absolute; width: 42%; height: 42%; animation: po-breathe-think calc(3s / var(--po-speed)) ease-in-out infinite; will-change: transform; }
.po-core { position: absolute; inset: 0; border-radius: 50%;
  background: radial-gradient(120% 120% at 32% 28% in oklab,
    color-mix(in oklab, var(--vz-po-c0), white 55%) 0%, var(--vz-po-c0) 16%, var(--vz-po-c1) 38%, var(--vz-po-c2) 66%,
    color-mix(in oklab, var(--vz-po-c2), var(--vz-po-c5) 45%) 100%);
  box-shadow: inset -6px -10px 18px color-mix(in oklab, var(--vz-po-c5), transparent 25%), inset 3px 5px 10px color-mix(in oklab, white, transparent 60%),
    0 10px 26px -10px color-mix(in oklab, var(--vz-po-c4), transparent 45%);
  scale: calc(1 + .14 * var(--po-level));
  animation: po-breathe-idle calc(4s / var(--po-speed)) ease-in-out infinite, po-blink calc(1.8s / var(--po-speed)) ease-in-out infinite;
  transition: filter var(--po-dur) var(--po-ease); will-change: transform; }
.po-core::before { content: ""; position: absolute; top: 10%; left: 16%; width: 40%; height: 26%; border-radius: 50%; background: radial-gradient(closest-side, rgb(255 255 255 / .9), transparent); filter: blur(1px); transform: rotate(-20deg); }
.po-core::after { content: ""; position: absolute; inset: 0; border-radius: 50%; background: ${NOISE}; mix-blend-mode: overlay; opacity: .1; }
.po[data-state="connecting"] .po-core { filter: saturate(.75) brightness(.98); }

.po-rings { --ring-play: paused; position: absolute; inset: 0; display: grid; place-items: center; opacity: 0;
  transition-property: opacity, --ring-play; transition-duration: var(--po-dur), var(--po-dur); transition-timing-function: var(--po-ease), step-end; transition-behavior: normal, allow-discrete; }
.po-rings-idle { --set-time: 1.85; }
.po-rings-listen { --set-time: .9; --set-dir: reverse; }
.po-rings-speak { --set-time: .667; }
.po[data-state="idle"] .po-rings-idle { opacity: .45; }
.po[data-state="listening"] .po-rings-listen, .po[data-state="speaking"] .po-rings-speak { opacity: 1; }
.po[data-state="idle"] .po-rings-idle, .po[data-state="listening"] .po-rings-listen, .po[data-state="speaking"] .po-rings-speak { --ring-play: running; transition-duration: var(--po-dur), 0s; }
.po-ring { position: absolute; width: 42%; height: 42%; border-radius: 50%; border: 1.5px solid; opacity: 0;
  animation: po-emit calc(var(--ring-base) * var(--set-time, 1) / var(--po-speed)) cubic-bezier(.16,.84,.44,1) calc(var(--ring-delay) * var(--set-time, 1) / var(--po-speed)) infinite var(--set-dir, normal);
  animation-play-state: var(--ring-play, running); }
.po-ring1 { --ring-base: 2.7s; --ring-delay: 0s; --ring-scale: 2.1; border-color: var(--vz-po-c3); }
.po-ring2 { --ring-base: 3.1s; --ring-delay: -1.1s; --ring-scale: 2.3; border-color: var(--vz-po-c4); }
.po-ring3 { --ring-base: 3.6s; --ring-delay: -2.3s; --ring-scale: 2.5; border-color: var(--vz-po-c5); }

.po-arc { position: absolute; width: 54%; height: 54%; opacity: 0; transition: opacity var(--po-dur) var(--po-ease); }
.po[data-state="connecting"] .po-arc { opacity: .75; }
.po[data-state="thinking"] .po-arc { opacity: 1; }
.po-arc-spin { position: absolute; inset: 0; animation: po-spin calc(2.4s / var(--po-speed)) linear infinite; }
.po-arc-turbo { position: absolute; inset: 0; animation: po-spin calc(4.8s / var(--po-speed)) linear infinite paused; }
.po[data-state="thinking"] .po-arc-turbo { animation-play-state: running; }
.po-arc-turbo::before { content: ""; position: absolute; inset: 0; border-radius: 50%;
  background: conic-gradient(from 0deg in oklab, transparent 40deg, color-mix(in oklab, var(--vz-po-c5), transparent 75%) 100deg, var(--vz-po-c4) 160deg,
    var(--vz-po-c3) 220deg, var(--vz-po-c2) 270deg, var(--vz-po-c1) 315deg, var(--vz-po-c0) 354deg, transparent 355deg);
  mask: radial-gradient(closest-side, transparent 89%, #000 93%, #000 96.5%, transparent 100%); }
.po-arc-turbo::after { content: ""; position: absolute; top: 2.75%; left: 50%; width: 6.5%; height: 6.5%; border-radius: 50%; background: var(--vz-po-c0);
  box-shadow: 0 0 6px color-mix(in oklab, var(--vz-po-c0), transparent 25%); transform: translate(-50%, -50%); }

@keyframes po-emit { 0% { transform: scale(1); opacity: 0; } 14% { opacity: calc(.4 + .5 * var(--po-level)); } 100% { transform: scale(var(--ring-scale)); opacity: 0; } }
@keyframes po-spin { to { transform: rotate(360deg); } }
@keyframes po-breathe-idle { 0%, 100% { transform: scale(1); } 50% { transform: scale(calc(1 + .05 * var(--vz-po-breathe-idle))); } }
@keyframes po-breathe-think { 0%, 100% { transform: scale(1); } 50% { transform: scale(calc(1 + .05 * var(--vz-po-breathe-think))); } }
@keyframes po-blink { 0%, 26%, 100% { opacity: 1; } 7%, 20% { opacity: calc(1 - .65 * var(--vz-po-blink)); } 13% { opacity: calc(1 - .1 * var(--vz-po-blink)); } }

@media (prefers-reduced-motion: reduce) {
  .po .po-core, .po .po-core-shell, .po .po-ring, .po .po-arc-spin, .po .po-arc-turbo { animation: none; }
  .po[data-state="listening"] .po-rings-listen, .po[data-state="speaking"] .po-rings-speak { opacity: 1; }
  .po[data-state="idle"] .po-rings-idle { opacity: .5; }
  .po-ring1 { transform: scale(1.2); opacity: .3; }
  .po-ring2 { transform: scale(1.5); opacity: .2; }
  .po-ring3 { transform: scale(1.8); opacity: .1; }
  .po[data-state="speaking"] .po-ring1 { transform: scale(1.35); opacity: .5; }
  .po[data-state="speaking"] .po-ring2 { transform: scale(1.7); opacity: .34; }
  .po[data-state="speaking"] .po-ring3 { transform: scale(2.05); opacity: .18; }
  .po[data-state="connecting"] .po-arc { opacity: .45; }
  .po[data-state="thinking"] .po-arc { opacity: .9; }
}
`;

const span = (cls: string, ...children: HTMLElement[]): HTMLElement => {
  const el = document.createElement("span");
  el.className = cls;
  el.append(...children);
  return el;
};

export function mountPulseOrb({ state: initial = "idle", size = 160, speed = 1, colors: initialColors = ORB_COLORS }: PulseOrbOptions = {}): PulseOrb {
  registerProperties();
  const el = document.createElement("div");
  el.className = "po";
  el.setAttribute("aria-hidden", "true");
  el.dataset.state = initial;
  el.style.setProperty("--po-size", `${size}px`);
  el.style.setProperty("--po-speed", String(speed));
  const rings = (set: string) => span(`po-rings ${set}`, span("po-ring po-ring1"), span("po-ring po-ring2"), span("po-ring po-ring3"));
  el.append(
    span("po-glow"),
    rings("po-rings-idle"), rings("po-rings-listen"), rings("po-rings-speak"),
    span("po-arc", span("po-arc-spin", span("po-arc-turbo"))),
    span("po-core-shell", span("po-core")),
  );

  let colorKey = "";
  const paint = (colors: readonly string[]) => {
    const six = sixStops(colors);
    const key = six.join("|");
    if (key === colorKey) return;
    colorKey = key;
    six.forEach((c, i) => el.style.setProperty(`--vz-po-c${i}`, c));
  };
  paint(initialColors);

  let state = initial;
  const weights = Object.fromEntries(STATE_KEYS.map((k) => [k, k === initial ? 1 : 0])) as Weights;
  let level = 0;
  let clock = 0;
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
    if (!reduced) clock += dt * speed;
    let target = 0;
    if (!reduced) for (const k of STATE_KEYS) if (weights[k] > 0) target += weights[k] * stateEnergy(k, clock);
    level = approach(level, target, target > level ? LEVEL_ATTACK_RATE : LEVEL_RELEASE_RATE, dt);
    el.style.setProperty("--po-level", level.toFixed(3));
    // A still state (idle, disabled, or anything with reduced motion) stops the loop once it has settled.
    const settled = weights[state] > 0.999 && target === 0 && level < 0.001;
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

  return {
    el,
    setState(next) {
      if (next === state) return;
      state = next;
      el.dataset.state = next;
      wake();
    },
    setColors(next) { paint(next); },
    destroy() {
      halt();
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      mq.removeEventListener("change", onMotion);
      el.remove();
    },
  };
}
