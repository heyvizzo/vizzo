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
/** Clicks during a turn (overlay dots, timeline ticks). */
export const CLICK_COLOR = "#22d3ee";
/** Highlighted text during a turn. */
export const SELECTION_COLOR = "#f0abfc";
