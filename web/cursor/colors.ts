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
