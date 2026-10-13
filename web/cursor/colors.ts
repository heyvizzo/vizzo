export const ALGO_COLORS: Record<string, string> = {
  atStart: "#f59e0b",
  dwell: "#22c55e",
  mode: "#3b82f6",
  dwellMode: "#e11d48",
};
export const LABEL_COLOR = "#ffffff";
export const colorFor = (algorithm: string): string => ALGO_COLORS[algorithm] ?? "#a3a3a3";
