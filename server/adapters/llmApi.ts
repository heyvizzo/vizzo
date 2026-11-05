import type { DrawingAnnotation } from "../../shared/annotations.ts";
import { anthropicContent, openaiContent } from "./drawing.ts";
// The fast tier (router and progress lines) called on a model API directly, instead of through a harness: one
// streamed HTTP request with the role's system prompt and the turn's real messages, no tools, no process to warm.
//   openrouter, fireworks, cerebras, openai, zai   OpenAI-style Chat Completions over SSE (fetch)
//   anthropic                                      the Messages API through @anthropic-ai/sdk
// Keys come from Settings (process.env, see API_KEY_ENV). Reasoning text is never passed on: only the answer streams.
// The result has a harness's shape (HarnessResult), so the router's stream parsing and fallbacks are the same.
import Anthropic from "@anthropic-ai/sdk";
import { API_KEY_ENV, LLM_PROVIDER_LABELS, type ApiProviderId, type LlmChoice } from "../../shared/config.ts";
import { claudeCost } from "../cost.ts";
import { priceOf, tokenCost } from "../prices.ts";
import type { ChatMessage } from "./claude.ts";
import type { HarnessResult, LlmUsage } from "./harnesses.ts";

/** Chat Completions base URLs (the request goes to `${base}/chat/completions`). */
export const API_BASE_URL: Record<Exclude<ApiProviderId, "anthropic">, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  cerebras: "https://api.cerebras.ai/v1",
  openai: "https://api.openai.com/v1",
  zai: "https://api.z.ai/api/paas/v4",
};

/** Output cap: the router writes ~100 tokens, but a reasoning model's thinking counts against it too. */
const MAX_OUTPUT_TOKENS = 4096;

export interface ApiRequest { system: string; messages: ChatMessage[]; annotations?: readonly DrawingAnnotation[] }

/** Tests: replace fetch (default: the global one) and the Anthropic client. */
let doFetch: typeof fetch = (...a) => fetch(...a);
export function setApiFetch(fn: typeof fetch | null): void { doFetch = fn ?? ((...a) => fetch(...a)); }
type AnthropicLike = Pick<Anthropic, "messages">;
let anthropicFactory: (apiKey: string) => AnthropicLike = (apiKey) => new Anthropic({ apiKey, maxRetries: 0 });
export function setAnthropicFactory(fn: ((apiKey: string) => AnthropicLike) | null): void {
  anthropicFactory = fn ?? ((apiKey) => new Anthropic({ apiKey, maxRetries: 0 }));
}

const label = (p: ApiProviderId): string => LLM_PROVIDER_LABELS[p];

function apiKey(p: ApiProviderId): string {
  const key = process.env[API_KEY_ENV[p]]?.trim();
  if (!key) throw new Error(`${label(p)}: no API key (add it in Settings → API keys)`);
  return key;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const isOff = (level: string | undefined): boolean => level === "off" || level === "none";

/**
 * The request fields that set the reasoning level, in each API's own terms. No level: none sent (the model's
 * default). "off"/"none" turns reasoning off where the API can; "on" turns it on without an effort.
 */
export function reasoningParams(p: Exclude<ApiProviderId, "anthropic">, level: string | undefined): Record<string, unknown> {
  if (!level) return {};
  switch (p) {
    case "openrouter":
      return { reasoning: isOff(level) ? { enabled: false } : level === "on" ? { enabled: true } : { effort: level } };
    case "zai":
      return isOff(level) ? { thinking: { type: "disabled" } } : { thinking: { type: "enabled" }, ...(level === "on" ? {} : { reasoning_effort: level }) };
    default:
      return level === "on" ? {} : { reasoning_effort: isOff(level) ? "none" : level };
  }
}

/** finish_reason in the Anthropic stop_reason terms the router checks. */
const STOP: Record<string, string> = { stop: "end_turn", length: "max_tokens", content_filter: "refusal", tool_calls: "tool_use" };

function usageOf(
  p: ApiProviderId, model: string, t: { input: number; output: number; cacheRead: number; cacheWrite: number }, reportedUsd?: number,
): LlmUsage {
  let usd: number | null = reportedUsd ?? null;
  if (usd === null) {
    const u = { input_tokens: t.input, output_tokens: t.output, cache_read_input_tokens: t.cacheRead, cache_creation_input_tokens: t.cacheWrite };
    if (p === "anthropic") usd = claudeCost(u, model, "fast");
    else {
      const price = priceOf(p, model);
      usd = price ? tokenCost(price, t) : null;
    }
  }
  return {
    input_tokens: t.input, output_tokens: t.output, cache_read_input_tokens: t.cacheRead, cache_creation_input_tokens: t.cacheWrite,
    llmCost: { usd, billing: "api" },
  };
}

/** Runs `fn` with an abort signal that fires after `ms`; a timeout is reported as one. */
async function withDeadline<T>(p: ApiProviderId, ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error(`${label(p)} timed out after ${ms} ms`)), ms);
  try {
    return await fn(ctl.signal);
  } catch (e) {
    if (ctl.signal.aborted) throw ctl.signal.reason;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ── Chat Completions (OpenRouter, Fireworks, Cerebras, OpenAI, Z.ai) ─────────

type ChatChunk = {
  model?: string;
  error?: { message?: string };
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: {
    prompt_tokens?: number; completion_tokens?: number; cost?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  } | null;
};

/** The SSE `data:` payloads of a response body, as they arrive (comment lines and [DONE] skipped). */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    buf += done ? dec.decode() : dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data && data !== "[DONE]") yield data;
    }
    if (done) {
      const last = buf.trim();
      if (last.startsWith("data:") && last.slice(5).trim() !== "[DONE]") yield last.slice(5).trim();
      return;
    }
  }
}

async function chatCompletions(
  p: Exclude<ApiProviderId, "anthropic">, choice: LlmChoice, req: ApiRequest, onText: ((d: string) => void) | undefined, timeoutMs: number,
): Promise<HarnessResult> {
  const key = apiKey(p);
  if (!choice.model) throw new Error(`${label(p)}: no model chosen`);
  const body = {
    model: choice.model,
    messages: [{ role: "system", content: req.system }, ...req.messages.map((m, i) => ({ ...m, content: i === req.messages.length - 1 && m.role === "user" ? openaiContent(m.content, req.annotations) : m.content }))],
    stream: true,
    stream_options: { include_usage: true },
    // OpenAI's reasoning models only take max_completion_tokens; the others take max_tokens.
    ...(p === "openai" ? { max_completion_tokens: MAX_OUTPUT_TOKENS } : { max_tokens: MAX_OUTPUT_TOKENS }),
    ...reasoningParams(p, choice.level),
  };
  return withDeadline(p, timeoutMs, async (signal) => {
    const res = await doFetch(`${API_BASE_URL[p]}/chat/completions`, {
      method: "POST", signal,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      let msg = text.slice(0, 300);
      try { msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg; } catch { /* not JSON */ }
      throw new Error(`${label(p)} HTTP ${res.status}${msg ? `: ${msg}` : ""}`);
    }
    let text = "";
    let model = choice.model;
    let finish: string | null = null;
    let usage: ChatChunk["usage"] = null;
    let last: ChatChunk | null = null;
    for await (const data of sseData(res.body)) {
      let chunk: ChatChunk;
      try { chunk = JSON.parse(data) as ChatChunk; } catch { continue; }
      if (chunk.error) throw new Error(`${label(p)}: ${chunk.error.message ?? "stream error"}`);
      last = chunk;
      if (chunk.model) model = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const c = chunk.choices?.[0];
      // Only the answer: reasoning arrives in delta.reasoning / reasoning_content and is dropped.
      const d = c?.delta?.content;
      if (d) { text += d; onText?.(d); }
      if (c?.finish_reason) finish = c.finish_reason;
    }
    const cacheRead = num(usage?.prompt_tokens_details?.cached_tokens);
    const cacheWrite = num(usage?.prompt_tokens_details?.cache_write_tokens);
    const t = { input: Math.max(0, num(usage?.prompt_tokens) - cacheRead - cacheWrite), output: num(usage?.completion_tokens), cacheRead, cacheWrite };
    return {
      text, model, stopReason: finish ? STOP[finish] ?? finish : null,
      usage: usage ? usageOf(p, model, t, typeof usage.cost === "number" ? usage.cost : undefined) : null,
      raw: { provider: p, finishReason: finish, usage, lastChunk: last }, warm: true,
    };
  });
}

// ── Anthropic Messages API ───────────────────────────────────────────────────

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

/** "off": thinking disabled. An effort: adaptive thinking at that effort. "on": adaptive at the model's default. */
export function anthropicThinking(level: string | undefined): Pick<Anthropic.MessageStreamParams, "thinking" | "output_config"> {
  if (!level) return {};
  if (isOff(level)) return { thinking: { type: "disabled" } };
  return { thinking: { type: "adaptive" }, ...(EFFORTS.has(level) ? { output_config: { effort: level as Effort } } : {}) };
}

async function anthropicMessages(choice: LlmChoice, req: ApiRequest, onText: ((d: string) => void) | undefined, timeoutMs: number): Promise<HarnessResult> {
  const client = anthropicFactory(apiKey("anthropic"));
  if (!choice.model) throw new Error(`${label("anthropic")}: no model chosen`);
  return withDeadline("anthropic", timeoutMs, async (signal) => {
    let text = "";
    const stream = client.messages.stream({
      model: choice.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      // The system prompt is the same every turn: cached (it changes only when the prompt files do).
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: req.messages.map((m, i) => ({ ...m, content: i === req.messages.length - 1 && m.role === "user" ? anthropicContent(m.content, req.annotations) : m.content })),
      ...anthropicThinking(choice.level),
    }, { signal });
    stream.on("text", (d) => { text += d; onText?.(d); });
    const final = await stream.finalMessage();
    const u = final.usage;
    const t = { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens) };
    return {
      text, model: final.model, stopReason: final.stop_reason ?? null, usage: usageOf("anthropic", final.model, t),
      raw: { provider: "anthropic", id: final.id, stopReason: final.stop_reason, usage: u }, warm: true,
    };
  });
}

/** One fast-tier request on a model API: streams the answer text to `onText`, resolves with the whole result. */
export function apiRequest(
  provider: ApiProviderId, choice: LlmChoice, req: ApiRequest, onText: ((d: string) => void) | undefined, timeoutMs: number,
): Promise<HarnessResult> {
  const request = provider === "anthropic"
    ? anthropicMessages(choice, req, onText, timeoutMs)
    : chatCompletions(provider, choice, req, onText, timeoutMs);
  return req.annotations?.length ? request.catch(err => {
    let detail = err instanceof Error ? err.message : String(err);
    for (const a of req.annotations!) detail = detail.replaceAll(a.image.dataUrl, "[image attachment]").replaceAll(a.image.dataUrl.slice(a.image.dataUrl.indexOf(",") + 1), "[image bytes]");
    throw new Error(`Drawing request to ${label(provider)} / ${choice.model} failed: ${detail}. Ensure the selected model supports image input.`);
  }) : request;
}

/** How a request is sent, for the prompt inspector. */
export function describeApi(provider: ApiProviderId, choice: LlmChoice): string {
  const where = provider === "anthropic" ? "POST https://api.anthropic.com/v1/messages (stream)" : `POST ${API_BASE_URL[provider]}/chat/completions (stream)`;
  const r = provider === "anthropic" ? anthropicThinking(choice.level) : reasoningParams(provider, choice.level);
  return `${where} · max ${MAX_OUTPUT_TOKENS} tokens${Object.keys(r).length ? ` · ${JSON.stringify(r)}` : ""}`;
}
