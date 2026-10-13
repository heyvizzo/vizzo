// Renders an LlmPrompt (exactly what a model was sent) for the Chat page's per-turn "Prompt" section.
// Fixed instructions and earlier turns are collapsed; this turn's message is shown in full.
import type { LlmPrompt, LlmResponse, PromptMessage } from "../../shared/protocol.ts";
import { fmtUsd } from "./costView.ts";

const TARGET_LABEL: Record<LlmPrompt["target"], string> = {
  router: "Haiku router",
  fillers: "Haiku progress lines",
  opus: "Opus",
  realtime: "OpenAI Realtime",
};

export const targetLabel = (t: LlmPrompt["target"]): string => TARGET_LABEL[t] ?? t;

export function fmtChars(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(0)}k chars` : n >= 1000 ? `${(n / 1000).toFixed(1)}k chars` : `${n} chars`;
}

/** The whole prompt as plain text (for the copy button). */
export function promptAsText(p: LlmPrompt): string {
  const out = [`# ${targetLabel(p.target)} · ${p.model}`];
  if (p.tools?.length) out.push(`tools: ${p.tools.join(", ")}${p.toolChoice ? ` (tool_choice ${p.toolChoice})` : ""}`);
  if (p.settings && Object.keys(p.settings).length) out.push(`settings: ${JSON.stringify(p.settings)}`);
  for (const s of p.system) out.push(`\n## system · ${s.label}${s.cached ? " (cached)" : ""}\n${s.text}`);
  for (const m of p.messages) out.push(`\n## ${m.role}${m.label ? ` · ${m.label}` : ""}\n${m.text}`);
  return out.join("\n");
}

/** One line of summary for the call, e.g. "Opus · anthropic/claude-opus-5.5 · 3 messages · 41k chars". */
export function promptSummary(p: LlmPrompt): string {
  const chars = p.system.reduce((n, s) => n + s.text.length, 0) + p.messages.reduce((n, m) => n + m.text.length, 0);
  const msgs = `${p.messages.length} message${p.messages.length === 1 ? "" : "s"}`;
  return `${targetLabel(p.target)} · ${p.model} · ${msgs} · ${fmtChars(chars)}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function messageBlock(m: PromptMessage): HTMLElement {
  const box = el("div", `pmsg role-${m.role}`);
  box.append(el("div", "pmsg-head", `${m.role}${m.label ? ` · ${m.label}` : ""}`), el("pre", undefined, m.text));
  return box;
}

/** A collapsible block for one model call. */
export function renderPrompt(p: LlmPrompt): HTMLDetailsElement {
  const call = el("details", "pcall");
  const summary = el("summary");
  summary.append(el("span", undefined, promptSummary(p)), el("span", "pbadge"));
  call.append(summary);

  const meta = el("div", "pmeta");
  if (p.tools?.length) meta.append(el("span", undefined, `tools: ${p.tools.join(", ")}${p.toolChoice ? ` · tool_choice ${p.toolChoice}` : ""}`));
  if (p.settings && Object.keys(p.settings).length) meta.append(el("span", undefined, JSON.stringify(p.settings)));
  const copy = el("button", "pcopy", "Copy");
  copy.type = "button";
  copy.onclick = () => {
    void navigator.clipboard?.writeText(promptAsText(p)).then(() => { copy.textContent = "Copied"; setTimeout(() => (copy.textContent = "Copy"), 1200); }, () => {});
  };
  meta.append(copy);
  call.append(meta);

  for (const s of p.system) {
    const d = el("details", "psys");
    d.append(el("summary", undefined, `system · ${s.label} · ${fmtChars(s.text.length)}${s.cached ? " · cached" : ""}`), el("pre", undefined, s.text));
    call.append(d);
  }

  const earlier = p.messages.filter((m) => !m.label?.startsWith("this turn") && m.label !== "note");
  const rest = p.messages.filter((m) => !earlier.includes(m));
  if (earlier.length) {
    const d = el("details", "psys");
    d.append(el("summary", undefined, `earlier turns · ${earlier.length} message${earlier.length === 1 ? "" : "s"}`));
    for (const m of earlier) d.append(messageBlock(m));
    call.append(d);
  }
  for (const m of rest) call.append(messageBlock(m));
  return call;
}

// ── Responses ───────────────────────────────────────────────────────────────

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const fmtN = (n: number) => n.toLocaleString("en-US");

/** "in 1,069 (cached 1,069) · out 187" for Anthropic or OpenAI Realtime usage; "" if unknown. */
export function usageSummary(usage: unknown): string {
  if (!usage || typeof usage !== "object") return "";
  const u = usage as Record<string, unknown>;
  const details = (u.input_token_details ?? {}) as Record<string, unknown>;
  const outDetails = (u.output_token_details ?? {}) as Record<string, unknown>;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  // Anthropic: input_tokens excludes cache reads/writes; OpenAI: cached_tokens is part of input_tokens.
  const cacheRead = num(u.cache_read_input_tokens) ?? num(details.cached_tokens);
  const cacheWrite = num(u.cache_creation_input_tokens);
  const audioIn = num(details.audio_tokens);
  const audioOut = num(outDetails.audio_tokens);
  const parts: string[] = [];
  if (input !== undefined) {
    const extra = [cacheRead ? `cache read ${fmtN(cacheRead)}` : "", cacheWrite ? `cache write ${fmtN(cacheWrite)}` : "", audioIn ? `audio ${fmtN(audioIn)}` : ""].filter(Boolean);
    parts.push(`in ${fmtN(input)}${extra.length ? ` (${extra.join(", ")})` : ""}`);
  }
  if (output !== undefined) parts.push(`out ${fmtN(output)}${audioOut ? ` (audio ${fmtN(audioOut)})` : ""}`);
  return parts.join(" · ");
}

/** "$0.016" for a billed call, "$0.016 saved" for one routed through the claude -p subscription. */
export function priceText(r: Pick<LlmResponse, "costUsd" | "savedUsd">): string {
  if (r.savedUsd !== undefined) return `${fmtUsd(r.savedUsd)} saved`;
  return r.costUsd !== undefined ? fmtUsd(r.costUsd) : "";
}

/** One line: "↳ answer · completed · in 1,069 (cache read 1,069) · out 187 · 1.4 s", or the error. */
export function responseSummary(r: LlmResponse): string {
  const time = r.durationMs !== undefined ? `${(r.durationMs / 1000).toFixed(1)} s` : "";
  if (r.error) return ["↳ error", r.label, r.error, time].filter(Boolean).join(" · ");
  return ["↳ response", r.label, r.stopReason ? `stop: ${r.stopReason}` : "", usageSummary(r.usage), time, priceText(r)].filter(Boolean).join(" · ");
}

/** A collapsible block with the raw payload as JSON. */
export function renderResponse(r: LlmResponse): HTMLDetailsElement {
  const d = el("details", `presp${r.error ? " err" : ""}`);
  d.append(el("summary", undefined, responseSummary(r)));
  if (r.raw !== undefined) d.append(el("pre", undefined, JSON.stringify(r.raw, null, 2)));
  return d;
}

/** Short status for the call's header: "✓ tool_use 1.4 s" / "✕ error". */
export function responseBadge(r: LlmResponse): string {
  if (r.error) return "✕ error";
  const time = r.durationMs !== undefined ? ` ${(r.durationMs / 1000).toFixed(1)} s` : "";
  const price = priceText(r);
  return `✓${r.label ? ` ${r.label}` : ""}${r.stopReason ? ` ${r.stopReason}` : ""}${time}${price ? ` · ${price}` : ""}`;
}

/** Attach a response to a rendered call (Realtime calls get several: ack, filler, answer…). */
export function addResponse(call: HTMLDetailsElement, r: LlmResponse): void {
  let box = call.querySelector<HTMLElement>(":scope > .presps");
  if (!box) { box = el("div", "presps"); call.append(box); }
  box.append(renderResponse(r));
  const n = [...box.querySelectorAll<HTMLElement>(":scope > details > summary")].length;
  // A call's cost is the sum of its responses (Realtime has several: ack, fillers, answer).
  const total = (Number(call.dataset.costUsd) || 0) + (r.costUsd ?? 0);
  const saved = (Number(call.dataset.savedUsd) || 0) + (r.savedUsd ?? 0);
  call.dataset.costUsd = String(total);
  call.dataset.savedUsd = String(saved);
  const sum = saved > 0 && total === 0 ? `${fmtUsd(saved)} saved` : fmtUsd(total);
  const badge = call.querySelector<HTMLElement>(":scope > summary > .pbadge");
  if (badge) badge.textContent = n > 1 ? ` · ${n} responses · ${sum} · last ${responseBadge(r)}` : ` · ${responseBadge(r)}`;
  if (r.error) call.classList.add("err");
}
