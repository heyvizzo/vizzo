// Colour helpers the conversation orbs share (pulseOrb.ts, plasmaOrb.ts): mixing in linear light, so blends don't
// go muddy in the middle.

export type Rgb = [number, number, number];

export const hexToRgb = (hex: string): Rgb => {
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
export const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb =>
  [toSrgb(toLinear(a[0]) + (toLinear(b[0]) - toLinear(a[0])) * t), toSrgb(toLinear(a[1]) + (toLinear(b[1]) - toLinear(a[1])) * t), toSrgb(toLinear(a[2]) + (toLinear(b[2]) - toLinear(a[2])) * t)];
export const rgbToHex = (c: Rgb): string => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
export const mixHex = (a: string, b: string, t: number): string => rgbToHex(mixRgb(hexToRgb(a), hexToRgb(b), t));

/** The colour at `t` (0–1) along evenly spaced stops (at least one). */
export function atStops(stops: readonly Rgb[], t: number): Rgb {
  if (stops.length < 2) return stops[0] ?? [255, 255, 255];
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  return mixRgb(stops[i]!, stops[i + 1]!, x - i);
}

/** `n` stops evenly along the gradient that `colors` make (the same colours when there are already `n`). */
export function resample(colors: readonly string[], n: number): string[] {
  if (colors.length === n) return [...colors];
  const rgb = colors.map(hexToRgb);
  return Array.from({ length: n }, (_, i) => rgbToHex(atStops(rgb, n === 1 ? 0 : i / (n - 1))));
}
