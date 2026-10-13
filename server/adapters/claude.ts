// Claude adapter (T6): Haiku router + Opus solver. Settings follow ARCHITECTURE §4 "Claude settings"
// and API-NOTES §Anthropic.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { MODELS, type RouterMode } from "../../shared/config.ts";
import { formatPointingLine } from "../../shared/pointing.ts";
import type { Intent, LlmPrompt, LlmResponse, PointingTarget, RouteIntent } from "../../shared/protocol.ts";
import { kindFor, parseEstimate, RouteInputStream, SpokenLineParser, type RouteFields } from "./claudeParse.ts";
import type { GenerateFillers, RouteDecision, RouteWithHaiku, SolveWithOpus } from "./types.ts";
import { trimDetail, type ChatTurn } from "../conversation.ts";
import { CLI_ARGS_SUMMARY, cliRequest, cliSpec, registerCliSpecs, type CliResult } from "./claudeCli.ts";

// ── Client injection (tests swap in a mock) ────────────────────────────────

/** The subset of the SDK client this adapter uses. A real `Anthropic` instance satisfies it. */
export type ClaudeClient = Pick<Anthropic, "messages" | "beta">;

let client: ClaudeClient | null = null;
let log: (msg: string) => void = (msg) => console.info(msg);

/** Inject a client (tests) or reset to the default lazily-created SDK client with `null`. */
export function setClient(c: ClaudeClient | null): void { client = c; }
/** Redirect the adapter's one-line usage logs (default: console.info). */
export function setLogger(fn: (msg: string) => void): void { log = fn; }

// ── Prompt capture (debug view on the Chat page) ───────────────────────────

type AnyParams = {
  model: string; system?: unknown; messages: { role: string; content: unknown }[];
  tools?: { name?: string }[]; tool_choice?: { type: string; name?: string };
  max_tokens?: number; output_config?: unknown; betas?: unknown; speed?: unknown; fallbacks?: unknown;
};

const blockText = (c: unknown): string =>
  typeof c === "string" ? c
    : Array.isArray(c) ? c.map((b: { type?: string; text?: string }) => (b.type === "text" ? b.text ?? "" : `[${b.type ?? "block"}]`)).join("\n")
    : "";

/** The request as sent, for display: labelled system blocks, messages (last one = this turn), tools, settings. */
export function promptInfo(target: LlmPrompt["target"], params: AnyParams, systemLabels: string[]): LlmPrompt {
  const sys = Array.isArray(params.system) ? params.system as { text?: string; cache_control?: unknown }[] : params.system ? [{ text: String(params.system) }] : [];
  const n = params.messages.length;
  return {
    target,
    model: params.model,
    system: sys.map((b, i) => ({ label: systemLabels[i] ?? `system ${i + 1}`, text: b.text ?? "", ...(b.cache_control ? { cached: true } : {}) })),
    messages: params.messages.map((m, i) => ({
      role: m.role as "user" | "assistant",
      text: blockText(m.content),
      label: i === n - 1 ? "this turn" : "earlier turn",
    })),
    ...(params.tools?.length ? { tools: params.tools.map((t) => t.name ?? "?") } : {}),
    ...(params.tool_choice ? { toolChoice: params.tool_choice.name ? `${params.tool_choice.type}: ${params.tool_choice.name}` : params.tool_choice.type } : {}),
    settings: Object.fromEntries(Object.entries({
      max_tokens: params.max_tokens, output_config: params.output_config, betas: params.betas, speed: params.speed, fallbacks: params.fallbacks,
    }).filter(([, v]) => v !== undefined)),
  };
}

/** The final message as a debug response (or the error), with the time since the request. */
export function responseInfo(
  target: LlmPrompt["target"], t0: number, final: { model?: string; stop_reason?: string | null; usage?: unknown } | null, err?: unknown,
): LlmResponse {
  return {
    target,
    ...(final?.model ? { model: final.model } : {}),
    ...(final ? { stopReason: final.stop_reason ?? null, usage: final.usage, raw: final } : {}),
    durationMs: Math.round(performance.now() - t0),
    ...(err !== undefined ? { error: err instanceof Error ? err.message : String(err) } : {}),
  };
}

// ── Spoken language ─────────────────────────────────────────────────────────

const LANGUAGE_NAMES: Record<string, string> = { en: "English", ro: "Romanian" };
export const languageName = (code: string): string => LANGUAGE_NAMES[code] ?? code;
/** A per-turn instruction line when the user didn't speak English ("" otherwise). */
export function languageLine(language: string | undefined, what: string): string {
  return language ? `The user spoke ${languageName(language)}: write ${what} in ${languageName(language)}.` : "";
}

// ── claude -p transport (pre-spawned agents, see claudeCli.ts) ───────────────────────────────────

/** The router's output format through the CLI (no forced tool call there): the tool's JSON, as text. */
const CLI_ROUTER_FORMAT = `

## Output format
Reply with ONLY one JSON object (no code fences, no other text), keys in exactly this order:
{"intent": "question" | "task" | "clarify" | "answer", "estimate_seconds": <integer or null>, "say": "<what to speak now>", "question": "<the delegated request, or empty>"}
"intent" and "estimate_seconds" come first because the reply is streamed and acted on as it arrives.`;

const CLI_FILLERS_FORMAT = `

## Output format
Reply with ONLY one JSON object (no code fences, no other text): {"lines": ["…", "…", "…"]}`;

registerCliSpecs(() => {
  const p = prompts();
  return {
    router: { model: MODELS.haiku, effort: "low", system: () => routerSystem() + CLI_ROUTER_FORMAT },
    fillers: { model: MODELS.haiku, effort: "low", system: () => p.fillers + CLI_FILLERS_FORMAT },
    opus: { model: MODELS.opus, effort: "medium", system: () => `${p.opus}\n\n${p.fixture}` },
  };
});

/** The API request's messages as one user message: earlier turns as a transcript, then this turn. */
export function cliUserMessage(params: AnyParams): string {
  const msgs = params.messages.map((m) => ({ role: m.role, text: blockText(m.content) }));
  const last = msgs.pop();
  if (!msgs.length) return last?.text ?? "";
  const history = msgs.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`).join("\n\n");
  return `Conversation so far (oldest first):\n\n${history}\n\n---\n\nThis turn:\n${last?.text ?? ""}`;
}

/** The first {...} object in a text (strips code fences / stray prose around it). */
export function extractJsonObject(text: string): string | null {
  const i = text.indexOf("{");
  const j = text.lastIndexOf("}");
  return i >= 0 && j > i ? text.slice(i, j + 1) : null;
}

/** What a claude -p agent was sent, for the prompt inspector. */
export function cliPromptInfo(target: "router" | "fillers" | "opus", params: AnyParams): LlmPrompt {
  const spec = cliSpec(target);
  const label = target === "router" ? "router.md + JSON output format" : target === "fillers" ? "fillers.md + JSON output format" : "opus.md + fixture codebase";
  return {
    target, model: `${spec.model} via claude -p`,
    system: [{ label: `${label} (--system-prompt)`, text: spec.system() }],
    messages: [{ role: "user", text: cliUserMessage(params), label: "this turn (one stream-json user message; earlier turns flattened in)" }],
    settings: { transport: "pre-spawned claude -p agent", effort: spec.effort, args: CLI_ARGS_SUMMARY },
  };
}

export function cliResponseInfo(target: LlmPrompt["target"], t0: number, r: CliResult): LlmResponse {
  return {
    target, model: r.model, stopReason: r.stopReason, usage: r.usage,
    durationMs: Math.round(performance.now() - t0),
    raw: { ...r.raw, warmAgent: r.warm, cliCostUsd: r.cliCostUsd, cliDurationMs: r.durationMs, cliDurationApiMs: r.durationApiMs },
  };
}

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

let cachedPrompts: { router: string; opus: string; fillers: string; fixture: string } | null = null;

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

function prompts(): { router: string; opus: string; fillers: string; fixture: string } {
  return (cachedPrompts ??= {
    router: readText("../prompts/router.md").trim(),
    opus: readText("../prompts/opus.md").trim(),
    fillers: readText("../prompts/fillers.md").trim(),
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
  // One line per pointing word (keyed by its reference number), using the best algorithm that resolved it.
  const byWord = new Map<string, PointingTarget[]>();
  for (const t of targets) {
    const key = t.ref !== undefined ? `#${t.ref}` : `${t.wordStart}|${t.word}`;
    byWord.set(key, [...(byWord.get(key) ?? []), t]);
  }
  const lines: string[] = [];
  for (const group of [...byWord.values()].sort((a, b) => a[0]!.wordStart - b[0]!.wordStart)) {
    const rank = (t: PointingTarget): number => {
      const i = ALGO_PREFERENCE.indexOf(t.algorithm);
      return (t.sample ? 0 : 100) + (i < 0 ? ALGO_PREFERENCE.length : i);
    };
    const best = [...group].sort((a, b) => rank(a) - rank(b))[0]!;
    lines.push(formatPointingLine({ ...best, word: best.word.replace(/[^\p{L}\p{N}'-]/gu, "") }));
  }
  return lines.length ? lines.join("\n") : "Pointing: none (the user was not pointing at anything we could resolve)";
}

// ── Haiku router ───────────────────────────────────────────────────────────

/**
 * Estimates above this many seconds count as long tasks. The router prompt tells the user "this will take a
 * while" above it (the number is substituted into router.md's {{LONG_TASK_SECONDS}}). Keep it in sync with
 * `RunConfig.longTaskSeconds`' default; the prompt can't follow a per-run override (types.ts has no field for it).
 */
export const DEFAULT_LONG_TASK_SECONDS = 20;

const ROUTE_INTENTS_AUTO = ["question", "task", "clarify", "answer"] as const satisfies readonly RouteIntent[];
const ROUTE_INTENTS_FORCED = ["question", "task", "clarify"] as const satisfies readonly RouteIntent[];

/**
 * The router's one tool, always forced (forced tool choice skips thinking: fastest first token). Property
 * order is the generation order: decision fields first, then the spoken text, then the question.
 * `forced` mode drops "answer" from the enum.
 */
export function routerTool(mode: RouterMode): Anthropic.Tool {
  return {
    name: "route",
    description:
      "Decide what the user wants and what to say right now. Fill the fields in order: intent, estimate_seconds, say, question. `say` is spoken aloud the moment you write it.",
    input_schema: {
      type: "object",
      properties: {
        intent: {
          type: "string",
          enum: mode === "forced" ? [...ROUTE_INTENTS_FORCED] : [...ROUTE_INTENTS_AUTO],
          description: mode === "forced"
            ? "question = wants information; task = wants something changed or done; clarify = you'd have to guess, so ask one follow-up question."
            : "question = wants information; task = wants something changed or done; clarify = you'd have to guess, so ask one follow-up question; answer = small talk you answer yourself.",
        },
        estimate_seconds: {
          type: "integer",
          description: "question/task only: how many seconds the colleague needs. Leave out for clarify/answer.",
        },
        say: { type: "string", description: "Spoken immediately. Rules depend on intent and estimate (see instructions)." },
        question: {
          type: "string",
          description: "question/task only: precise, self-contained request for the colleague, with pointing words resolved (label + data-source). Leave out for clarify/answer.",
        },
      },
      required: ["intent", "say"],
    },
    eager_input_streaming: true,
  };
}

export interface RouterInput { intent: RouteIntent; estimateS: number | null; say: string; question: string }

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

/** Validates the complete `route` input. question/task need a question; clarify/answer need something to say. */
export function validateRouterInput(v: unknown, mode: RouterMode = "auto"): RouterInput | null {
  if (typeof v !== "object" || v === null) return null;
  const { intent, estimate_seconds, say, question } = v as Record<string, unknown>;
  const allowed: readonly string[] = mode === "forced" ? ROUTE_INTENTS_FORCED : ROUTE_INTENTS_AUTO;
  if (typeof intent !== "string" || !allowed.includes(intent)) return null;
  const i = intent as RouteIntent;
  const sayText = typeof say === "string" ? say.trim() : "";
  if (i === "question" || i === "task") {
    if (typeof question !== "string" || !question.trim()) return null;
    return { intent: i, estimateS: parseEstimate(estimate_seconds), say: sayText, question: question.trim() };
  }
  if (!sayText) return null;
  return { intent: i, estimateS: null, say: sayText, question: "" };
}

function routerSystem(): string {
  return prompts().router.replaceAll("{{LONG_TASK_SECONDS}}", String(DEFAULT_LONG_TASK_SECONDS));
}

const MODE_LINE: Record<RouterMode, string> = {
  forced: "Mode: delegate. Never answer yourself: use question or task, or clarify if you'd have to guess.",
  auto: "Mode: auto. You may use answer for small talk or trivial things; otherwise question, task or clarify.",
};

export function buildRouterParams(
  transcript: string, pointing: PointingTarget[], mode: RouterMode, history: ChatTurn[] = [],
  extra: { pageContext?: string; longTaskSeconds?: number; language?: string } = {},
): Anthropic.MessageStreamParams {
  // Per-turn context goes in the user message so the cached system prompt stays byte-identical.
  const lines = [`${MODE_LINE[mode]}`, `Transcript: "${transcript}"`, formatPointingForPrompt(pointing)];
  if (extra.pageContext) lines.push(extra.pageContext);
  const lang = languageLine(extra.language, "`say` (and a clarifying question)");
  if (lang) lines.push(lang);
  if (extra.longTaskSeconds !== undefined && extra.longTaskSeconds !== DEFAULT_LONG_TASK_SECONDS) {
    lines.push(`Long-task threshold for this conversation: ${extra.longTaskSeconds} seconds (use it instead of ${DEFAULT_LONG_TASK_SECONDS}).`);
  }
  const tool = routerTool(mode);
  return {
    model: modelId(MODELS.haiku),
    max_tokens: 2048,
    output_config: { effort: "low" },
    // No temperature/top_p/top_k: non-default values are a 400 on Haiku 5.5.
    system: [{ type: "text", text: routerSystem(), cache_control: { type: "ephemeral" } }],
    tools: [tool],
    // Forced in both modes: no thinking block, the tool input starts streaming right away.
    tool_choice: { type: "tool", name: tool.name, disable_parallel_tool_use: true },
    messages: [...historyMessages(history, false), {
      role: "user",
      content: lines.join("\n"),
    }],
  };
}

export const routeWithHaiku: RouteWithHaiku = async ({
  mark, transcript, pointing, mode, history, pageContext, longTaskSeconds, language, onDecision, onSpokenDelta, onSpokenEnd, onPrompt, onResponse, backend,
}) => {
  const params = buildRouterParams(transcript, pointing, mode, history, { pageContext, longTaskSeconds, language });
  const cli = backend === "cli";
  onPrompt?.(cli ? cliPromptInfo("router", params as AnyParams) : promptInfo("router", params as AnyParams, ["router.md"]));
  const route = new RouteInputStream(
    {
      onDecision: (d) => onDecision?.(d),
      onSay: (d, kind) => onSpokenDelta(d, kind),
      onSayEnd: (kind) => onSpokenEnd?.(kind),
    },
    mode === "forced" ? ROUTE_INTENTS_FORCED : ROUTE_INTENTS_AUTO,
    mode === "forced" ? "clarify" : "answer",
  );
  let firstToken = false;
  let toolIndex = -1;
  let json = "";
  const first = (): void => { if (!firstToken) { firstToken = true; mark("llm.firstToken"); } };

  mark("llm.request", { model: params.model, mode, ...(cli ? { backend: "claude -p" } : {}) });
  const t0 = performance.now();
  let streamError: unknown = null;
  let final: Anthropic.Message | null = null;
  if (cli) {
    // claude -p: the same JSON, written as text (no forced tool call through the CLI). Feed it from the first "{".
    let started = false;
    try {
      const res = await cliRequest("router", cliUserMessage(params as AnyParams), {
        onText: (d) => {
          first();
          let chunk = d;
          if (!started) {
            const i = chunk.indexOf("{");
            if (i < 0) return;
            started = true;
            chunk = chunk.slice(i);
            toolIndex = 0;
            mark("llm.toolCall", { name: "route (json text)" });
          }
          json += chunk;
          route.feed(chunk);
        },
      });
      json = extractJsonObject(json) ?? json;
      final = { model: res.model ?? params.model, stop_reason: res.stopReason ?? "end_turn", usage: res.usage, content: [] } as unknown as Anthropic.Message;
      onResponse?.(cliResponseInfo("router", t0, res));
    } catch (err) {
      onResponse?.(responseInfo("router", t0, null, err));
      if (!started) throw err;
      streamError = err;
    }
  } else {
    const stream = getClient().messages.stream(params);
    try {
      for await (const ev of stream) {
        if (ev.type === "content_block_start" && ev.content_block.type === "tool_use" && toolIndex < 0) {
          toolIndex = ev.index;
          mark("llm.toolCall", { name: ev.content_block.name });
        } else if (ev.type === "content_block_delta" && ev.delta.type === "input_json_delta" && ev.index === toolIndex) {
          first();
          json += ev.delta.partial_json;
          route.feed(ev.delta.partial_json);
        }
        // Text blocks can't occur with a forced tool choice; ignore them if they ever do.
      }
      final = await stream.finalMessage();
      onResponse?.(responseInfo("router", t0, final));
    } catch (err) {
      onResponse?.(responseInfo("router", t0, null, err));
      // Typed API errors (auth, rate limit, 5xx…) propagate. Anything else here is the SDK failing
      // to parse eagerly-streamed tool JSON; we handle that below like an invalid input.
      if (err instanceof Anthropic.APIError || toolIndex < 0) throw err;
      streamError = err;
    }
  }

  if (final?.stop_reason === "refusal") {
    // No server-side fallback exists for Haiku 5.5 (API-NOTES): surface it.
    throw new ClaudeRefusalError(params.model, final.stop_details?.category ?? null, final.stop_details?.explanation ?? null);
  }
  const usage = final?.usage ?? null;
  if (usage) logUsage("haiku", usage);

  // Validate the eagerly-streamed input ourselves (it isn't validated server-side).
  let parsed: unknown = null;
  if (!streamError && final?.stop_reason !== "max_tokens") {
    if (json) {
      try { parsed = JSON.parse(json); } catch { parsed = null; }
    } else {
      parsed = final?.content.find((b) => b.type === "tool_use")?.input ?? null;
    }
  }
  const input = validateRouterInput(parsed, mode);

  if (input) {
    route.finish({ ...(parsed as RouteFields), intent: input.intent });
    const decision: RouteDecision = { intent: input.intent, estimateS: input.estimateS };
    const streamed = route.decision!;
    if (streamed.intent !== decision.intent || streamed.estimateS !== decision.estimateS) {
      log(`[claude] haiku route: streamed decision ${JSON.stringify(streamed)} differs from final ${JSON.stringify(decision)}`);
    }
    if (input.intent === "question" || input.intent === "task") {
      return { delegate: { question: input.question, intent: input.intent, estimateS: input.estimateS }, decision, usage };
    }
    return { delegate: null, decision, usage };
  }

  // Invalid or truncated input.
  const why = `stop_reason=${final?.stop_reason ?? "error"}`;
  const streamed = route.decision;
  if (streamed && kindFor(streamed.intent) === "answer" && route.sayComplete && route.spoken.trim()) {
    // The reply (a follow-up question or a direct answer) was complete and already spoken; only the tail broke.
    log(`[claude] haiku route input invalid after a complete ${streamed.intent} (${why}); keeping it`);
    route.finish();
    return { delegate: null, decision: streamed, usage };
  }
  if (!transcript.trim()) {
    log(`[claude] haiku route input invalid (${why}) and the transcript is empty; nothing to delegate`);
    route.finish({ intent: "clarify" });
    return { delegate: null, decision: route.decision!, usage };
  }
  // Degrade gracefully: delegate the raw transcript + pointing (keeping a question/task decision already announced).
  log(`[claude] haiku route input invalid (${why}); delegating raw transcript`);
  route.finish({ intent: "question" });
  const d = route.decision!;
  const decision: RouteDecision = kindFor(d.intent) === "ack" ? d : { intent: "question", estimateS: null };
  return {
    delegate: { question: `${transcript}\n${formatPointingForPrompt(pointing)}`, intent: decision.intent as Intent, estimateS: decision.estimateS },
    decision,
    usage,
  };
};

// ── Fillers (spoken progress lines while Opus works on a short task) ───────

export const FILLERS_TOOL: Anthropic.Tool = {
  name: "progress",
  description: "Three short spoken progress updates, in the order they will be said.",
  input_schema: {
    type: "object",
    properties: {
      lines: { type: "array", items: { type: "string" }, description: "Exactly 3 lines, 4 to 10 words each." },
    },
    required: ["lines"],
  },
};

export function buildFillersParams(
  transcript: string, question: string, intent: Intent, pointing: PointingTarget[], language?: string,
): Anthropic.MessageCreateParamsNonStreaming {
  const lang = languageLine(language, "the lines");
  return {
    model: modelId(MODELS.haiku),
    max_tokens: 512,
    output_config: { effort: "low" },
    system: [{ type: "text", text: prompts().fillers, cache_control: { type: "ephemeral" } }],
    tools: [FILLERS_TOOL],
    tool_choice: { type: "tool", name: FILLERS_TOOL.name, disable_parallel_tool_use: true },
    messages: [{
      role: "user",
      content: `Intent: ${intent === "task" ? "task (the user wants something changed)" : "question (the user wants information)"}\nUser said: "${transcript}"\nRequest passed to the colleague: ${question}\n${formatPointingForPrompt(pointing)}${lang ? `\n${lang}` : ""}`,
    }],
  };
}

const MAX_FILLERS = 3;

export const generateFillers: GenerateFillers = async ({ transcript, question, intent, pointing, language, onPrompt, onResponse, backend }) => {
  const t0 = performance.now();
  try {
    const fp = buildFillersParams(transcript, question, intent, pointing, language);
    if (backend === "cli") {
      onPrompt?.(cliPromptInfo("fillers", fp as AnyParams));
      const res = await cliRequest("fillers", cliUserMessage(fp as AnyParams));
      onResponse?.(cliResponseInfo("fillers", t0, res));
      let parsed: { lines?: unknown } | null = null;
      try { parsed = JSON.parse(extractJsonObject(res.text) ?? "null"); } catch { parsed = null; }
      const lines = (Array.isArray(parsed?.lines) ? parsed.lines : []).filter((l): l is string => typeof l === "string").map((l) => l.trim()).filter(Boolean).slice(0, MAX_FILLERS);
      if (!lines.length) log(`[claude] fillers (claude -p): no usable lines in ${JSON.stringify(res.text.slice(0, 120))}`);
      return { lines, usage: res.usage ?? null };
    }
    onPrompt?.(promptInfo("fillers", fp as AnyParams, ["fillers.md"]));
    const msg = await getClient().messages.create(fp);
    onResponse?.(responseInfo("fillers", t0, msg));
    if (msg.usage) logUsage("haiku fillers", msg.usage);
    if (msg.stop_reason === "refusal") {
      log("[claude] haiku fillers refused; no fillers");
      return { lines: [], usage: msg.usage ?? null };
    }
    const input = msg.content.find((b) => b.type === "tool_use")?.input as { lines?: unknown } | undefined;
    const raw = Array.isArray(input?.lines) ? input.lines : [];
    const lines = raw.filter((l): l is string => typeof l === "string").map((l) => l.trim()).filter(Boolean).slice(0, MAX_FILLERS);
    if (!lines.length) log(`[claude] haiku fillers: no usable lines (stop_reason=${msg.stop_reason})`);
    return { lines, usage: msg.usage ?? null };
  } catch (err) {
    onResponse?.(responseInfo("fillers", t0, null, err));
    log(`[claude] haiku fillers failed: ${err instanceof Error ? err.message : String(err)}`);
    return { lines: [], usage: null };
  }
};

// ── Opus solver ────────────────────────────────────────────────────────────

const FAST_BETA = "fast-mode-2026-02-01";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** The last user message for Opus. Tasks are framed as change requests here, so the system blocks never change (cache). */
export function opusUserMessage(
  question: string, pointing: PointingTarget[], intent: Intent = "question", pageContext?: string, language?: string,
): string {
  const lang = languageLine(language, "the SPOKEN line and the detailed answer");
  const pointed = `Pointing context (from the user's cursor):\n${formatPointingForPrompt(pointing)}${pageContext ? `\n${pageContext}` : ""}${lang ? `\n\n${lang}` : ""}`;
  if (intent === "task") {
    return `Request type: TASK. This is a change request: the user wants something changed. You can't edit files in this session, so describe the change you would make, using the task format.\n\nTask: ${question}\n\n${pointed}`;
  }
  return `Question: ${question}\n\n${pointed}`;
}

export function buildOpusParams(
  question: string, pointing: PointingTarget[], fast: boolean, history: ChatTurn[] = [], intent: Intent = "question",
  pageContext?: string, language?: string,
): BetaMessageStreamParams {
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
      content: opusUserMessage(question, pointing, intent, pageContext, language),
    }],
    // OpenRouter rejects `fallbacks: "default"` (400), so the refusal fallback is Anthropic-direct only.
    // It accepts `speed: "fast"` but serves standard speed (usage.speed === "standard"); cost follows usage.speed.
    ...(claudeProvider() === "anthropic"
      ? { betas: fast ? [FAST_BETA, FALLBACK_BETA] : [FALLBACK_BETA], fallbacks: "default" as const }
      : fast ? { betas: [FAST_BETA] } : {}),
    ...(fast ? { speed: "fast" as const } : {}),
  };
}

export const solveWithOpus: SolveWithOpus = async ({ mark, question, pointing, fast, history, intent, onSpokenLine, onDelta, pageContext, onPrompt, onResponse, language, backend }) => {
  const t0 = performance.now();
  const cli = backend === "cli";
  let text = "";
  let firstToken = false;
  let spokenReady = false;
  let fastFellBack = false;
  const fallbacks: { from: string; to: string }[] = [];
  let cliResult: CliResult | null = null;
  const parser = new SpokenLineParser((line, viaPrefix) => {
    spokenReady = true;
    mark("opus.spokenReady", { viaPrefix });
    onSpokenLine(line);
  });

  const run = async (useFast: boolean): Promise<Anthropic.Beta.Messages.BetaMessage> => {
    if (cli) {
      // claude -p: same system text and messages; fast mode / refusal fallback aren't available through the CLI.
      const params = buildOpusParams(question, pointing, false, history, intent, pageContext, language);
      onPrompt?.(cliPromptInfo("opus", params as AnyParams));
      mark("opus.request", { model: params.model, fast: false, backend: "claude -p", ...(intent === "task" ? { intent } : {}) });
      const res = await cliRequest("opus", cliUserMessage(params as AnyParams), {
        onText: (d) => {
          if (!firstToken) { firstToken = true; mark("opus.firstToken"); }
          text += d;
          onDelta(d);
          parser.feed(d);
        },
      });
      cliResult = res;
      return { model: res.model ?? params.model, stop_reason: res.stopReason ?? "end_turn", usage: res.usage ?? {}, content: [] } as unknown as Anthropic.Beta.Messages.BetaMessage;
    }
    const params = buildOpusParams(question, pointing, useFast, history, intent, pageContext, language);
    if (!fastFellBack) onPrompt?.(promptInfo("opus", params as AnyParams, ["opus.md", "fixture codebase"]));
    mark("opus.request", { model: params.model, fast: useFast, ...(intent === "task" ? { intent } : {}), ...(fastFellBack ? { fastFallback: true } : {}) });
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
    try {
      final = await run(fast);
    } catch (err) {
      // Fast mode has its own rate limit: on a 429 before any output, retry at standard speed.
      if (!(fast && err instanceof Anthropic.RateLimitError && !firstToken)) throw err;
      fastFellBack = true;
      log("[claude] opus fast mode 429; falling back to standard speed");
      final = await run(false);
    }
  } catch (err) {
    onResponse?.(responseInfo("opus", t0, null, err));
    throw err;
  }
  onResponse?.(cliResult ? cliResponseInfo("opus", t0, cliResult) : responseInfo("opus", t0, final));

  if (!spokenReady) parser.end();
  const usage = final.usage;
  mark("opus.done", {
    stopReason: final.stop_reason,
    speed: usage?.speed ?? null,
    cacheReadInputTokens: usage?.cache_read_input_tokens ?? 0,
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

