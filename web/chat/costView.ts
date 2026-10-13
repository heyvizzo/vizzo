// Cost display for the Chat page: per model call (in the prompt inspector) and per turn, including the
// background task a turn started.
import type { CostItem } from "../../shared/protocol.ts";

/** "$0.0018" below a cent, "$0.032" up to a dollar, "$1.24" above. */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "–";
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export interface TurnCost {
  /** The turn's own items (model calls, TTS, STT). */
  items: CostItem[];
  total: number;
  /** Background tasks this turn started (filled in as they finish). */
  jobs: { label: string; items: CostItem[]; total: number; running: boolean }[];
}

export interface Savings { subscription: number; onDevice: number; total: number }

/** What wasn't billed, by source (items without savedVia predate it: they were all claude -p). */
export function savingsOf(items: CostItem[]): Savings {
  let subscription = 0, onDevice = 0;
  for (const i of items) {
    if (!i.savedUsd) continue;
    if (i.savedVia === "on-device") onDevice += i.savedUsd;
    else subscription += i.savedUsd;
  }
  return { subscription, onDevice, total: subscription + onDevice };
}

/** Everything saved in this turn and its background tasks. */
export function turnSavings(c: TurnCost): Savings {
  return savingsOf([...c.items, ...c.jobs.flatMap((j) => j.items)]);
}

export function totalSaved(c: TurnCost): number {
  return turnSavings(c).total;
}

/** "$0.024 saved (claude -p $0.019 · on-device TTS $0.005)", or "" when nothing was saved. */
export function savingsText(s: Savings): string {
  if (s.total <= 0) return "";
  const parts = [s.subscription > 0 ? `claude -p ${fmtUsd(s.subscription)}` : "", s.onDevice > 0 ? `on-device TTS ${fmtUsd(s.onDevice)}` : ""].filter(Boolean);
  return `${fmtUsd(s.total)} saved${parts.length > 1 || s.onDevice > 0 ? ` (${parts.join(" · ")})` : " (subscription)"}`;
}

/**
 * One line: "cost $0.031", "cost $0.045 · turn $0.031 + background task $0.014 (running…)", plus
 * "· $0.017 saved" when Claude calls went through the claude -p subscription (not billed).
 */
export function costHeadline(c: TurnCost): string {
  const jobsTotal = c.jobs.reduce((n, j) => n + j.total, 0);
  const running = c.jobs.some((j) => j.running);
  const saved = savingsText(turnSavings(c));
  const savedPart = saved ? ` · ${saved}` : "";
  if (!c.jobs.length) return `cost ${fmtUsd(c.total)}${savedPart}`;
  const parts = c.jobs.map((j) => `${j.label} ${fmtUsd(j.total)}${j.running ? " so far" : ""}`);
  return `cost ${fmtUsd(c.total + jobsTotal)}${running ? "+" : ""} · turn ${fmtUsd(c.total)} + ${parts.join(" + ")}${savedPart}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function rows(table: HTMLTableElement, items: CostItem[], group?: string): void {
  if (group) {
    const tr = el("tr", "cgroup");
    const th = el("th", undefined, group);
    th.colSpan = 3;
    tr.append(th);
    table.append(tr);
  }
  for (const i of items) {
    const tr = el("tr");
    const sub = i.savedUsd !== undefined && i.usd === 0;
    tr.append(el("td", undefined, i.label), el("td", "cdetail", i.detail ?? ""), el("td", sub ? "cusd saved" : "cusd", sub ? `${fmtUsd(i.savedUsd!)} saved` : fmtUsd(i.usd)));
    table.append(tr);
  }
}

/** Collapsible per-turn cost: headline, then every item (and the background tasks' items). */
export function renderTurnCost(box: HTMLElement, c: TurnCost): void {
  const wasOpen = box.querySelector("details")?.open ?? false;
  box.replaceChildren();
  const d = el("details", "cost");
  d.open = wasOpen;
  d.append(el("summary", undefined, costHeadline(c)));
  const table = el("table", "ctable");
  rows(table, c.items, c.jobs.length ? "this turn" : undefined);
  for (const j of c.jobs) rows(table, j.items, `${j.label}${j.running ? " (running…)" : ""}`);
  const total = el("tr", "ctotal");
  const jobsTotal = c.jobs.reduce((n, j) => n + j.total, 0);
  total.append(el("td", undefined, "total billed"), el("td"), el("td", "cusd", fmtUsd(c.total + jobsTotal)));
  table.append(total);
  const sv = turnSavings(c);
  for (const [label, usd] of [["saved via claude -p (subscription)", sv.subscription], ["saved via on-device TTS (vs ElevenLabs)", sv.onDevice]] as const) {
    if (usd <= 0) continue;
    const tr = el("tr", "ctotal");
    tr.append(el("td", undefined, label), el("td"), el("td", "cusd saved", fmtUsd(usd)));
    table.append(tr);
  }
  d.append(table);
  box.append(d);
}
