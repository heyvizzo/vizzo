// Renders an LlmPrompt (exactly what a model was sent) for the Chat page's per-turn "Prompt" section.
// Fixed instructions and earlier turns are collapsed; this turn's message is shown in full.
import type { LlmPrompt, PromptMessage } from "../../shared/protocol.ts";

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
  const summary = el("summary", undefined, promptSummary(p));
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
