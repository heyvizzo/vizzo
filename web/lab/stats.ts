// Pure stats / grouping / export helpers for the latency lab (PRD FR5). No DOM.
import type { RunConfig } from "../../shared/config.ts";
import { deriveMetrics, MARK_NAMES, METRIC_NAMES, type MarkName, type Metrics } from "../../shared/marks.ts";
import type { RunRecord } from "../../shared/protocol.ts";

export const TABLE_METRICS = [...METRIC_NAMES, "costUsd"] as const;
export type TableMetric = (typeof TABLE_METRICS)[number];

export interface Summary { n: number; p50: number | null; p90: number | null; mean: number | null }

/** Percentile with linear interpolation between closest ranks (numpy's default): rank = p/100 · (n − 1). */
export function percentile(values: readonly number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (xs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return xs[lo]! + (xs[hi]! - xs[lo]!) * (rank - lo);
}

export function mean(values: readonly number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Summary over the finite values; null/undefined/NaN are skipped (n counts only real values). */
export function summarize(values: readonly (number | null | undefined)[]): Summary {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return { n: xs.length, p50: percentile(xs, 50), p90: percentile(xs, 90), mean: mean(xs) };
}

export function metricValue(run: RunRecord, m: TableMetric): number | null {
  if (m === "costUsd") return Number.isFinite(run.costUsd) ? run.costUsd : null;
  return run.metrics?.[m] ?? null;
}

export type GroupBy = "approach" | "variant";

/**
 * Config variant key: the approach plus only the fields that affect that approach's path, so an irrelevant
 * field (e.g. routerMode for realtime) doesn't split a group. Cold (prewarm off) runs are their own variant.
 */
export function variantKey(c: RunConfig): string {
  const parts: string[] = [c.approach];
  if (c.approach === "realtime" || c.approach === "hybrid") parts.push(c.realtimeModel.replace("gpt-realtime-", "rt-"));
  if (c.approach === "pipeline") parts.push(`router:${c.routerMode}`, c.ttsModel.replace("eleven_", ""));
  if (c.approach === "hybrid") parts.push(`wait:${c.hybridWaitMs}`);
  if (c.approach !== "cursor-only") parts.push(c.opusFast ? "opus:fast" : "opus:std");
  if (!c.prewarm) parts.push("cold");
  if (c.memory) parts.push("chat");
  if (c.claudeBackend === "api") parts.push("claude:api");
  return parts.join(" · ");
}

export function groupKey(run: RunRecord, by: GroupBy): string {
  return by === "approach" ? run.approach : variantKey(run.config);
}

const APPROACH_ORDER = ["realtime", "pipeline", "hybrid", "cursor-only"];

/** Group runs; groups ordered by approach (A, B, C) then key. */
export function groupRuns(runs: readonly RunRecord[], by: GroupBy): Map<string, RunRecord[]> {
  const m = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const k = groupKey(r, by);
    const g = m.get(k);
    if (g) g.push(r);
    else m.set(k, [r]);
  }
  const rank = (k: string) => {
    const i = APPROACH_ORDER.findIndex((a) => k === a || k.startsWith(`${a} `));
    return i < 0 ? APPROACH_ORDER.length : i;
  };
  return new Map([...m].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)));
}

export interface GroupSummary { key: string; n: number; stats: Record<TableMetric, Summary> }

export function summaryTable(runs: readonly RunRecord[], by: GroupBy, fixtureId: string | null = null): GroupSummary[] {
  const filtered = fixtureId === null ? runs : runs.filter((r) => (r.fixtureId ?? "") === fixtureId);
  return [...groupRuns(filtered, by)].map(([key, rs]) => ({
    key,
    n: rs.length,
    stats: Object.fromEntries(TABLE_METRICS.map((m) => [m, summarize(rs.map((r) => metricValue(r, m)))])) as Record<TableMetric, Summary>,
  }));
}

/** Server RunRecord + client-stamped marks (client wins for client marks); metrics recomputed. */
export function mergeRun(run: RunRecord, clientMarks: Partial<Record<MarkName, number>>): RunRecord {
  const marks = { ...run.marks };
  for (const [k, v] of Object.entries(clientMarks) as [MarkName, number | undefined][]) if (v !== undefined) marks[k] = v;
  return { ...run, marks, metrics: deriveMetrics(marks) };
}

/** Normalize a run loaded from disk / the API: fill missing fields and recompute metrics. */
export function normalizeRun(r: RunRecord): RunRecord {
  const marks = r.marks ?? {};
  return { ...r, marks, metrics: deriveMetrics(marks), pointing: r.pointing ?? [], costUsd: r.costUsd ?? 0 };
}

// ── export ──────────────────────────────────────────

export type Cell = string | number | boolean | null;

const CONFIG_KEYS = ["approach", "realtimeModel", "opusFast", "routerMode", "hybridWaitMs", "ttsModel", "prewarm", "preMs", "postMs"] as const;

/** One flat row per run: ids, config, metrics, cost, clock, marks relative to release (ms), texts. */
export function flattenRun(r: RunRecord): Record<string, Cell> {
  const row: Record<string, Cell> = {
    runId: r.runId, turnId: r.turnId, fixtureId: r.fixtureId ?? null, approach: r.approach, variant: variantKey(r.config),
  };
  for (const k of CONFIG_KEYS) row[`config.${k}`] = r.config?.[k] ?? null;
  for (const m of METRIC_NAMES) row[m] = (r.metrics as Metrics | undefined)?.[m] ?? null;
  row.costUsd = r.costUsd ?? null;
  row.rttMs = r.clock?.rttMs ?? null;
  row.offsetMs = r.clock?.offsetMs ?? null;
  const rel = r.marks?.release;
  for (const n of MARK_NAMES) {
    const v = r.marks?.[n];
    row[`mark.${n}`] = v === undefined || rel === undefined ? null : v - rel;
  }
  row.transcript = r.transcript ?? "";
  row.error = r.error ?? null;
  return row;
}

function csvCell(v: Cell): string {
  if (v === null) return "";
  const s = typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(runs: readonly RunRecord[]): string {
  const rows = runs.map(flattenRun);
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  if (!cols.length) return "";
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c] ?? null)).join(","))].join("\r\n") + "\r\n";
}
