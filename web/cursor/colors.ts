import { LOGO, themeCss } from "../../shared/theme.ts";

export const ALGO_COLORS: Record<string, string> = {
  atStart: "#f59e0b",
  dwell: "#22c55e",
  mode: "#3b82f6",
  dwellMode: "#e11d48",
};
export const LABEL_COLOR = "#ffffff";
export const colorFor = (algorithm: string): string => ALGO_COLORS[algorithm] ?? "#a3a3a3";
/** Live hover outline (the specific element under the pointer; its container dashed). */
export const HOVER_COLOR = "#a78bfa";
/** Click events during a turn (overlay dots + outlines, timeline ticks, list badges). */
export const CLICK_COLOR = "#22d3ee";
/** Highlights made during the recording (same blue as the recorder's ::highlight(turn-highlights) paint). */
export const HIGHLIGHT_COLOR = "#6ea8fe";
/** Text already highlighted when the recording started (the recorder paints it amber). */
export const PRESELECTED_COLOR = "#fbbf24";
/** Cursor rests (@1, @2…): where the pointer stayed on one element while the user spoke (language-agnostic). */
export const REST_COLOR = "#f472b6";

/**
 * What a thread or the conversation is doing, in one palette for every marker of it: the conversation orb's particles,
 * the thread markers on the page, the Chat sidebar's thread dots and job pills. Each is a gradient, light to deep.
 * The orb draws working, listening and idle in ORB_COLORS instead; `done` is for finished threads (the orb has none).
 * These are for dark backgrounds (the sidebar, dark pages); STATE_COLORS_ON_LIGHT is the deeper set for light pages.
 */
export const STATE_COLORS = {
  working: { from: "#a5abff", to: "#3549c4" },
  asking: { from: "#fde68a", to: "#f59e0b" },
  failed: { from: "#fb7185", to: "#f43f5e" },
  done: { from: "#86efac", to: "#22c55e" },
  queued: { from: "#d4d4d8", to: "#a1a1aa" },
} as const;
export type StateColor = keyof typeof STATE_COLORS;
/** Pastels fade into a light page: the same hues, deeper. */
export const STATE_COLORS_ON_LIGHT: Record<StateColor, { from: string; to: string }> = {
  working: { from: "#4a57d6", to: "#001993" },
  asking: { from: "#f59e0b", to: "#b45309" },
  failed: { from: "#f43f5e", to: "#be123c" },
  done: { from: "#22c55e", to: "#15803d" },
  queued: { from: "#a1a1aa", to: "#71717a" },
};
/**
 * The conversation orb's own colours when it isn't asking or failed: all six of the logo's, the V's cyan, teal and
 * green, then the field's blues (in the Pulse Orb, pulseOrb.ts, that's its core then its glow and rings).
 */
export const ORB_COLORS: readonly string[] = [LOGO.v.from, LOGO.v.mid, LOGO.v.to, LOGO.field.from, LOGO.field.mid, LOGO.field.to];
/**
 * The conversation orb's colours while its last reply is asking you something: the V's cyan, light to deep, so it
 * stands apart from its usual blues. Only the orb; asking thread markers stay amber (STATE_COLORS.asking).
 */
export const ORB_ASKING_COLORS: readonly string[] = ["#a6fffe", LOGO.v.from, "#00c9d8", LOGO.v.mid, "#0a8fa8"];
/** What's behind a marker: a light or a dark background. */
export type Tone = "light" | "dark";
export const stateColors = (tone: Tone): Record<StateColor, { from: string; to: string }> => (tone === "light" ? STATE_COLORS_ON_LIGHT : STATE_COLORS);

/** "rgb(…)" / "rgba(…)" (a computed colour) → its tone, or null when it's mostly transparent or not parsed. */
export function toneOfCss(color: string): Tone | null {
  const m = /^rgba?\(([^)]+)\)$/.exec(color.trim());
  if (!m) return null;
  const [r = 0, g = 0, b = 0, a = 1] = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
  if (!(a > 0.5)) return null;
  // Relative luminance (sRGB), split at the middle grey.
  const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) > 0.18 ? "light" : "dark";
}
/** One beat of the working pulse, matching the orb's thinking beat (sin(2.6 t): about 2.4 s). */
export const BEAT_S = 2.4;
/** The ring drawn round whichever marker's panel is open. */
export const OPEN_RING = "0 0 0 3px rgba(110,168,254,.6)";

/** A small marker's fill: the gradient lit from the top left, like the orb. */
export const stateFill = (s: StateColor, tone: Tone = "dark"): string => {
  const c = stateColors(tone)[s];
  return `radial-gradient(circle at 35% 30%, ${c.from}, ${c.to} 75%)`;
};

/** The palette as CSS custom properties (--st-<state>, --st-<state>-to, --st-<state>-fill, --st-beat), for a background. */
export function stateColorVars(tone: Tone = "dark"): Record<string, string> {
  const vars: Record<string, string> = { "--st-beat": `${BEAT_S}s`, "--st-open-ring": OPEN_RING };
  const colors = stateColors(tone);
  for (const s of Object.keys(colors) as StateColor[]) {
    vars[`--st-${s}`] = colors[s].from;
    vars[`--st-${s}-to`] = colors[s].to;
    vars[`--st-${s}-fill`] = stateFill(s, tone);
  }
  return vars;
}

/**
 * The page overlay's panels (thread panel and bubbles, comment bubble, inline form) follow the system theme, like the
 * Chat sidebar and Settings: the app's theme (shared/theme.ts) as --ui-* custom properties, light unless the system is dark.
 */
export const UI_THEME_CSS = `
${themeCss({ scope: ":host, .th-layer, .cm-layer", prefix: "ui-", dataTheme: false })}`;
