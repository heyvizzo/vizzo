// Claude adapter (T6): Haiku router + Opus solver. Settings follow ARCHITECTURE §4 "Claude settings"
// and API-NOTES §Anthropic.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { MODELS } from "../../shared/config.ts";
import type { PointingTarget } from "../../shared/protocol.ts";
import { JsonStringFieldExtractor, SpokenLineParser } from "./claudeParse.ts";
import type { RouteWithHaiku, SolveWithOpus } from "./types.ts";
import { trimDetail, type ChatTurn } from "../conversation.ts";

// ── Client injection (tests swap in a mock) ────────────────────────────────

/** The subset of the SDK client this adapter uses. A real `Anthropic` instance satisfies it. */
export type ClaudeClient = Pick<Anthropic, "messages" | "beta">;

let client: ClaudeClient | null = null;
let log: (msg: string) => void = (msg) => console.info(msg);

/** Inject a client (tests) or reset to the default lazily-created SDK client with `null`. */
export function setClient(c: ClaudeClient | null): void { client = c; }
/** Redirect the adapter's one-line usage logs (default: console.info). */
export function setLogger(fn: (msg: string) => void): void { log = fn; }

// ── Provider: OpenRouter (Anthropic-compatible Messages API) or Anthropic directly ──

export type ClaudeProvider = "openrouter" | "anthropic";

/** CLAUDE_PROVIDER wins; otherwise OpenRouter whenever OPENROUTER_API_KEY is set. */
export function claudeProvider(): ClaudeProvider {
  const p = process.env.CLAUDE_PROVIDER;
  if (p === "openrouter" || p === "anthropic") return p;
  return process.env.OPENROUTER_API_KEY ? "openrouter" : "anthropic";
}

export function hasClaudeCredentials(): boolean {
  return claudeProvider() === "openrouter" ? !!process.env.OPENROUTER_API_KEY : !!process.env.ANTHROPIC_API_KEY;
}

const OPENROUTER_BASE_URL = "https://openrouter.ai/api";
const OPENROUTER_MODELS: Record<string, string> = {
  [MODELS.haiku]: "anthropic/claude-haiku-5.5",
  [MODELS.opus]: "anthropic/claude-opus-5.5",
};

/** Model ID for the active provider. */
export function modelId(model: string): string {
  return claudeProvider() === "openrouter" ? (OPENROUTER_MODELS[model] ?? model) : model;
}

function getClient(): ClaudeClient {
  // maxRetries: 2 is the SDK default; fast-mode requests override it to 0 (see solveWithOpus).
  if (client) return client;
  if (claudeProvider() === "openrouter") {
    return (client = new Anthropic({
      baseURL: OPENROUTER_BASE_URL,
      apiKey: null,
      authToken: process.env.OPENROUTER_API_KEY ?? null,
      defaultHeaders: { "X-Title": "Realtime Voice Latency Lab" },
    }));
  }
  return (client = new Anthropic());
}

export class ClaudeRefusalError extends Error {
  constructor(readonly model: string, readonly category: string | null, readonly explanation: string | null) {
    super(`${model} refused (stop_reason: "refusal"${category ? `, category: ${category}` : ""})`);
    this.name = "ClaudeRefusalError";
  }
}

// ── Prompts and fixture context (loaded once, byte-stable so the cache prefix matches) ──

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const readText = (p: string): string => readFileSync(here(p), "utf8");

/** Files Opus answers questions about, in a fixed order. `path` is how the model sees them. */
const FIXTURE_FILES: { file: string; path: string; numbered: boolean }[] = [
  { file: "demo.html", path: "web/cursor/demo/demo.html", numbered: true },
  { file: "demo.css", path: "web/cursor/demo/demo.css", numbered: true },
  { file: "demo.ts", path: "web/cursor/demo/demo.ts", numbered: true },
  { file: "DECISIONS.md", path: "DECISIONS.md", numbered: false },
  { file: "claude-code-session.md", path: "notes/claude-code-session-2026-03-18.md", numbered: false },
];

let cachedPrompts: { router: string; opus: string; fixture: string } | null = null;

export function loadFixtureContext(): string {
  const parts = FIXTURE_FILES.map(({ file, path, numbered }) => {
    const text = readText(`../fixtures-context/${file}`).replace(/\s+$/, "");
    const body = numbered
      ? text.split("\n").map((line, i) => `${String(i + 1).padStart(3, " ")}| ${line}`).join("\n")
      : text;
    return `<file path="${path}"${numbered ? ' line_numbers="true"' : ""}>\n${body}\n</file>`;
  });
  return `<codebase name="lumen-site">\nCode files are shown with line numbers ("NN| ") that are not part of the file.\n\n${parts.join("\n\n")}\n</codebase>`;
}

function prompts(): { router: string; opus: string; fixture: string } {
  return (cachedPrompts ??= {
    router: readText("../prompts/router.md").trim(),
    opus: readText("../prompts/opus.md").trim(),
    fixture: loadFixtureContext(),
  });
}

// ── Pointing formatter (local; shared/pointing.ts formatPointingContext belongs to T9) ──

const ALGO_PREFERENCE = ["dwellMode", "dwell", "mode", "atStart"];

function tagFromPath(path: string | null): string {
  if (!path) return "element";
  const last = path.split(">").pop()!.trim();
  const tag = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(last)?.[0];
  return tag ? tag.toLowerCase() : "element";
}

/**
 * One line per pointing word, using the preferred algorithm's pick:
 * `Pointing: "this" → <div> "Feature card grid" [data-source=web/cursor/demo/demo.html:34]`
 */
export function formatPointingForPrompt(targets: PointingTarget[]): string {
  const byWord = new Map<string, PointingTarget[]>();
  for (const t of targets) {
    const key = `${t.wordStart}|${t.word}`;
    byWord.set(key, [...(byWord.get(key) ?? []), t]);
  }
  const lines: string[] = [];
  for (const group of [...byWord.values()].sort((a, b) => a[0]!.wordStart - b[0]!.wordStart)) {
    const rank = (t: PointingTarget): number => {
      const i = ALGO_PREFERENCE.indexOf(t.algorithm);
      return (t.sample ? 0 : 100) + (i < 0 ? ALGO_PREFERENCE.length : i);
    };
    const best = [...group].sort((a, b) => rank(a) - rank(b))[0]!;
    const word = best.word.replace(/[^\p{L}\p{N}'-]/gu, "");
    const s = best.sample;
    if (!s) { lines.push(`Pointing: "${word}" → (no element resolved)`); continue; }
    const label = s.label ? ` "${s.label}"` : "";
    const src = s.dataSource ? ` [data-source=${s.dataSource}]` : "";
    lines.push(`Pointing: "${word}" → <${tagFromPath(s.elementPath)}>${label}${src}`);
  }
  return lines.length ? lines.join("\n") : "Pointing: none (the user was not pointing at anything we could resolve)";
}

// ── Haiku router ───────────────────────────────────────────────────────────

/** Router-only variant of ask_opus: the spoken ack is inside the tool input so it streams first. */
export const ROUTER_TOOL: Anthropic.Tool = {
  name: "ask_opus",
  description:
    "Delegate a question about the user's app or codebase to a stronger model that has the full source and design history. Fill `ack` first: it is spoken aloud immediately.",
  input_schema: {
    type: "object",
    properties: {
      ack: { type: "string", description: "Short spoken acknowledgment, one sentence of 3 to 10 words. Spoken immediately." },
      question: { type: "string", description: "Precise, self-contained question including the pointed-at element's label and data-source file:line." },
    },
    required: ["ack", "question"],
  },
  eager_input_streaming: true,
};

export interface RouterInput { ack: string; question: string }

type HistoryMessage = { role: "user" | "assistant"; content: string };

/** Earlier chat turns as alternating user/assistant messages (never empty content). */
export function historyMessages(history: ChatTurn[], forOpus: boolean): HistoryMessage[] {
  return history.flatMap((t): HistoryMessage[] => [
    { role: "user", content: t.user || "(inaudible)" },
    {
      role: "assistant",
      // Opus answers in the SPOKEN:-first format; replay its own detailed answer when it gave one.
      content: (forOpus ? (t.detail ? trimDetail(t.detail) : `SPOKEN: ${t.assistant}`) : t.assistant) || "(no reply)",
    },
  ]);
}

export function validateRouterInput(v: unknown): RouterInput | null {
  if (typeof v !== "object" || v === null) return null;
  const { ack, question } = v as Record<string, unknown>;
  if (typeof ack !== "string" || typeof question !== "string" || !question.trim()) return null;
  return { ack, question: question.trim() };
}

export function buildRouterParams(
  transcript: string, pointing: PointingTarget[], mode: "forced" | "auto", history: ChatTurn[] = [],
): Anthropic.MessageStreamParams {
  return {
    model: modelId(MODELS.haiku),
    max_tokens: 2048,
    output_config: { effort: "low" },
    // No temperature/top_p/top_k: non-default values are a 400 on Haiku 5.5.
    system: [{ type: "text", text: prompts().router, cache_control: { type: "ephemeral" } }],
    tools: [ROUTER_TOOL],
    tool_choice: mode === "forced"
      ? { type: "tool", name: ROUTER_TOOL.name, disable_parallel_tool_use: true }
      : { type: "auto", disable_parallel_tool_use: true },
    messages: [...historyMessages(history, false), {
      role: "user",
      content: `${mode === "forced" ? "Mode: always delegate with ask_opus." : "Mode: you may answer trivial questions directly; otherwise call ask_opus."}\nTranscript: "${transcript}"\n${formatPointingForPrompt(pointing)}`,
    }],
  };
}

export const routeWithHaiku: RouteWithHaiku = async ({ mark, transcript, pointing, mode, history, onSpokenDelta, onSpokenEnd }) => {
  const params = buildRouterParams(transcript, pointing, mode, history);
  const ack = new JsonStringFieldExtractor("ack");
  let firstToken = false;
  let toolIndex = -1;
  let json = "";
  let spokenText = "";
  let ackEnded = false;
  const endAck = (): void => { if (!ackEnded) { ackEnded = true; onSpokenEnd?.("ack"); } };
  const first = (): void => { if (!firstToken) { firstToken = true; mark("llm.firstToken"); } };

  mark("llm.request", { model: params.model, mode });
  const stream = getClient().messages.stream(params);
  let streamError: unknown = null;
  let final: Anthropic.Message | null = null;
  try {
    for await (const ev of stream) {
      if (ev.type === "content_block_start" && ev.content_block.type === "tool_use") {
        toolIndex = ev.index;
        mark("llm.toolCall", { name: ev.content_block.name });
      } else if (ev.type === "content_block_delta") {
        if (ev.delta.type === "text_delta") {
          first();
          spokenText += ev.delta.text;
          onSpokenDelta(ev.delta.text, "answer");
        } else if (ev.delta.type === "input_json_delta" && ev.index === toolIndex) {
          first();
          json += ev.delta.partial_json;
          const out = ack.feed(ev.delta.partial_json);
          if (out) onSpokenDelta(out, "ack");
          if (ack.done) endAck();
        }
      }
    }
    final = await stream.finalMessage();
  } catch (err) {
    // Typed API errors (auth, rate limit, 5xx…) propagate. Anything else here is the SDK failing
    // to parse eagerly-streamed tool JSON; we handle that below like an invalid input.
    if (err instanceof Anthropic.APIError || toolIndex < 0) throw err;
    streamError = err;
  }

  if (final?.stop_reason === "refusal") {
    // No server-side fallback exists for Haiku 5.5 (API-NOTES): surface it.
    throw new ClaudeRefusalError(params.model, final.stop_details?.category ?? null, final.stop_details?.explanation ?? null);
  }
  const usage = final?.usage ?? null;
  if (usage) logUsage("haiku", usage);

  if (toolIndex < 0) {
    // Direct spoken answer (auto mode).
    if (final?.stop_reason === "max_tokens") log(`[claude] haiku direct answer hit max_tokens (${spokenText.length} chars spoken)`);
    return { delegate: null, decision: { intent: "answer" as const, estimateS: null }, usage };
  }

  // Tool call: validate the eagerly-streamed input ourselves (it isn't validated server-side).
  let parsed: unknown = null;
  if (!streamError && final?.stop_reason !== "max_tokens") {
    if (json) {
      try { parsed = JSON.parse(json); } catch { parsed = null; }
    } else {
      parsed = final?.content.find((b) => b.type === "tool_use")?.input ?? null;
    }
  }
  const input = validateRouterInput(parsed);
  if (!input) {
    // Degrade gracefully: still delegate, with the raw transcript + pointing as the question.
    log(`[claude] haiku ask_opus input invalid (stop_reason=${final?.stop_reason ?? "error"}); delegating raw transcript`);
    return { delegate: { question: `${transcript}\n${formatPointingForPrompt(pointing)}`, intent: "question" as const, estimateS: null }, decision: { intent: "question" as const, estimateS: null }, usage };
  }
  // If the extractor fell behind the final value (shouldn't happen), speak the remainder.
  if (input.ack.startsWith(ack.value) && input.ack.length > ack.value.length) onSpokenDelta(input.ack.slice(ack.value.length), "ack");
  endAck();
  return { delegate: { question: input.question, intent: "question" as const, estimateS: null }, decision: { intent: "question" as const, estimateS: null }, usage };
};

// ── Opus solver ────────────────────────────────────────────────────────────

const FAST_BETA = "fast-mode-2026-02-01";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export function buildOpusParams(question: string, pointing: PointingTarget[], fast: boolean, history: ChatTurn[] = []): BetaMessageStreamParams {
  const p = prompts();
  return {
    model: modelId(MODELS.opus),
    max_tokens: 16000,
    output_config: { effort: "medium" }, // explicit: Opus 5.5 can't disable thinking; effort is the control
    system: [
      { type: "text", text: p.opus },
      { type: "text", text: p.fixture, cache_control: { type: "ephemeral" } },
    ],
    messages: [...historyMessages(history, true), {
      role: "user",
      content: `Question: ${question}\n\nPointing context (from the user's cursor):\n${formatPointingForPrompt(pointing)}`,
    }],
    // OpenRouter rejects `fallbacks: "default"` (400), so the refusal fallback is Anthropic-direct only.
    // It accepts `speed: "fast"` but serves standard speed (usage.speed === "standard"); cost follows usage.speed.
    ...(claudeProvider() === "anthropic"
      ? { betas: fast ? [FAST_BETA, FALLBACK_BETA] : [FALLBACK_BETA], fallbacks: "default" as const }
      : fast ? { betas: [FAST_BETA] } : {}),
    ...(fast ? { speed: "fast" as const } : {}),
  };
}

export const solveWithOpus: SolveWithOpus = async ({ mark, question, pointing, fast, history, onSpokenLine, onDelta }) => {
  let text = "";
  let firstToken = false;
  let spokenReady = false;
  let fastFellBack = false;
  const fallbacks: { from: string; to: string }[] = [];
  const parser = new SpokenLineParser((line, viaPrefix) => {
    spokenReady = true;
    mark("opus.spokenReady", { viaPrefix });
    onSpokenLine(line);
  });

  const run = async (useFast: boolean): Promise<Anthropic.Beta.Messages.BetaMessage> => {
    const params = buildOpusParams(question, pointing, useFast, history);
    mark("opus.request", { model: params.model, fast: useFast, ...(fastFellBack ? { fastFallback: true } : {}) });
    // Fast mode: no SDK retries, so a 429 falls back to standard speed right away.
    const stream = getClient().beta.messages.stream(params, useFast ? { maxRetries: 0 } : undefined);
    for await (const ev of stream) {
      if (ev.type === "content_block_start" && ev.content_block.type === "fallback") {
        fallbacks.push({ from: ev.content_block.from.model, to: ev.content_block.to.model });
      } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        if (!firstToken) { firstToken = true; mark("opus.firstToken"); }
        text += ev.delta.text;
        onDelta(ev.delta.text);
        parser.feed(ev.delta.text);
      }
    }
    return stream.finalMessage();
  };

  let final: Anthropic.Beta.Messages.BetaMessage;
  try {
    final = await run(fast);
  } catch (err) {
    // Fast mode has its own rate limit: on a 429 before any output, retry at standard speed.
    if (!(fast && err instanceof Anthropic.RateLimitError && !firstToken)) throw err;
    fastFellBack = true;
    log("[claude] opus fast mode 429; falling back to standard speed");
    final = await run(false);
  }

  if (!spokenReady) parser.end();
  const usage = final.usage;
  mark("opus.done", {
    stopReason: final.stop_reason,
    speed: usage.speed ?? null,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    ...(fastFellBack ? { fastFallback: true } : {}),
    ...(fallbacks.length ? { refusalFallbacks: fallbacks } : {}),
  });
  logUsage("opus", usage, final.model);

  if (final.stop_reason === "refusal") {
    // The whole fallback chain declined; any partial text must be discarded by the caller.
    throw new ClaudeRefusalError(final.model, final.stop_details?.category ?? null, final.stop_details?.explanation ?? null);
  }
  if (final.stop_reason === "max_tokens") log(`[claude] opus hit max_tokens; answer is truncated`);
  return { text, usage };
};

function logUsage(
  who: string,
  u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number | null; cache_creation_input_tokens: number | null; speed?: string | null },
  model?: string,
): void {
  log(
    `[claude] ${who}${model ? ` (${model})` : ""} usage: input=${u.input_tokens} cache_read=${u.cache_read_input_tokens ?? 0} ` +
      `cache_write=${u.cache_creation_input_tokens ?? 0} output=${u.output_tokens}${u.speed ? ` speed=${u.speed}` : ""}`,
  );
}

// TEMP stub (replaced by the router agent).
export const generateFillers: import("./types.ts").GenerateFillers = async () => ({ lines: [], usage: null });
