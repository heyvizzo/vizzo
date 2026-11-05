import type { DrawingAnnotation } from "../../shared/annotations.ts";
import { attachmentSummary, drawingContext, redactImagePayloads } from "./drawing.ts";
// The model tiers' three jobs: the router and the progress lines (fast tier, the router's job) and the solver
// (smart tier, the solver's job), each run on a warm harness agent (warmPool.ts / harnesses.ts) chosen per tier in
// RunConfig.llm. The fast tier can instead call a model API directly (llmApi.ts), with the same prompts. The router and the progress lines write their answer as one JSON object in text (no tool
// call through a harness), streamed and acted on as it arrives; the solver answers in the SPOKEN:-first format.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, isApiProvider, LLM_PROVIDER_LABELS, type LlmChoice, type LlmProvider, type RouterMode } from "../../shared/config.ts";
import { formatPointingLine } from "../../shared/pointing.ts";
import type { Intent, LlmPrompt, LlmResponse, PointingTarget, RouteIntent } from "../../shared/protocol.ts";
import {
  kindFor, NarrationGate, parseEstimate, resolveThreadRoute, RouteInputStream, SpokenLineParser, type RouteFields, type ThreadRouteContext,
} from "./claudeParse.ts";
import type { GenerateFillers, RouteDecision, RouteTurn, SolveInThread, SolveTask, ThreadBrief } from "./types.ts";
import { trimDetail, type ChatTurn } from "../conversation.ts";
import type { CliRole } from "./claudeCli.ts";
import { describeAgent, type HarnessResult } from "./harnesses.ts";
import { agentSpec, harnessRequest, registerRoleSpecs, ROLE_TIER } from "./warmPool.ts";
import { apiRequest, describeApi } from "./llmApi.ts";
import { projectDir } from "../project.ts";
import { gitContext } from "../gitContext.ts";
import { SERVER_DIR } from "../paths.ts";
import { FISH_ACK_CUES, FISH_FILLER_CUES, FISH_SOLVER_CUES } from "./voiceCues.ts";

let log: (msg: string) => void = (msg) => console.info(msg);
/** Redirect the adapter's one-line usage logs (default: console.info). */
export function setLogger(fn: (msg: string) => void): void { log = fn; }

/** How long each role may take before the request is given up. */
export const ROLE_TIMEOUT_MS: Record<CliRole, number> = { router: 30_000, fillers: 20_000, solver: 180_000 };

// ── Requests (what a role sends: earlier turns + this turn) ──────────────────

export interface ChatMessage { role: "user" | "assistant"; content: string }
/** The messages of one request. A harness gets them flattened into one user message (`flattenMessages`). */
export interface ChatParams { messages: ChatMessage[]; annotations?: readonly DrawingAnnotation[] }

function attachDrawing(params: ChatParams, annotation?: DrawingAnnotation, history: ChatTurn[] = []): ChatParams {
  const all = [...history.flatMap(t => t.annotation ? [t.annotation] : []), ...(annotation ? [annotation] : [])];
  const seen = new Set<string>();
  const images = all.reverse().filter(a => { if (seen.has(a.id)) return false; seen.add(a.id); return true; }).slice(0, 4).reverse();
  if (!images.length) return params;
  const last = params.messages.at(-1);
  if (last) last.content += `${annotation ? `\n\n${drawingContext(annotation)}` : ""}\n\nAttached images, in order: ${images.map(a => a.id).join(", ")}. Match image IDs to the drawing context in this conversation.`;
  params.annotations = images;
  return params;
}

/** The request's messages as one user message: earlier turns as a transcript, then this turn. */
export function flattenMessages(params: ChatParams): string {
  const msgs = [...params.messages];
  const last = msgs.pop();
  if (!msgs.length) return last?.content ?? "";
  const history = msgs.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n\n");
  return `Conversation so far (oldest first):\n\n${history}\n\n---\n\nThis turn:\n${last?.content ?? ""}`;
}

/** The first {...} object in a text (strips code fences / stray prose around it). */
export function extractJsonObject(text: string): string | null {
  const i = text.indexOf("{");
  const j = text.lastIndexOf("}");
  return i >= 0 && j > i ? text.slice(i, j + 1) : null;
}

// ── Prompt capture (debug view on the Chat page) ───────────────────────────

const ROLE_PROMPT_LABEL: Record<CliRole, string> = { router: "router.md + JSON output format", fillers: "fillers.md + JSON output format", solver: "solver.md" };

/** What a call was sent, for the prompt inspector. */
export function harnessPromptInfo(role: CliRole, choice: LlmChoice, params: ChatParams): LlmPrompt {
  const provider = choice.provider;
  if (isApiProvider(provider)) {
    // A model API gets the turns as real messages, not flattened.
    return {
      target: role, model: `${choice.model || "no model"} via ${LLM_PROVIDER_LABELS[provider]}`,
      system: [{ label: ROLE_PROMPT_LABEL[role], text: roleSystem(role, provider).system }],
      messages: params.messages.map((m, i) => ({ role: m.role, text: m.content, ...(i === params.messages.length - 1 ? { label: "this turn" } : {}) })),
      settings: { ...(params.annotations?.length ? { attachments: attachmentSummary(params.annotations) } : {}), api: LLM_PROVIDER_LABELS[provider], ...(choice.level ? { level: choice.level } : {}), run: describeApi(provider, choice) },
    };
  }
  const spec = agentSpec(role, choice);
  return {
    target: role, model: `${spec.model || "default model"} via ${LLM_PROVIDER_LABELS[spec.harness]}`,
    system: [{ label: ROLE_PROMPT_LABEL[role] + (spec.project ? " + project note" : ""), text: spec.system }],
    messages: [{ role: "user", text: flattenMessages(params), label: "this turn (earlier turns flattened in)" }],
    settings: {
      ...(params.annotations?.length ? { attachments: attachmentSummary(params.annotations) } : {}),
      harness: LLM_PROVIDER_LABELS[spec.harness], ...(spec.level ? { level: spec.level } : {}), ...(spec.speed ? { speed: spec.speed } : {}),
      ...(spec.project ? { cwd: spec.project } : {}), run: describeAgent(spec),
    },
  };
}

/** The result of a call as a debug response, with the time since the request. */
export function harnessResponseInfo(target: LlmPrompt["target"], t0: number, r: HarnessResult, choice: LlmChoice): LlmResponse {
  const own = (r.usage as { llmCost?: { billing?: "api" | "subscription" } } | null)?.llmCost;
  const speed = (r.usage as { speed?: string } | null)?.speed;
  return {
    target, model: r.model, stopReason: r.stopReason, usage: r.usage,
    // Claude Code runs on the subscription; the others say who pays.
    billing: own?.billing ?? "subscription",
    durationMs: Math.round(performance.now() - t0),
    raw: {
      ...(typeof r.raw === "object" && r.raw ? redactImagePayloads(r.raw) as object : { raw: redactImagePayloads(r.raw) }), warmAgent: r.warm,
      ...(choice.speed === "fast" && speed && speed !== "fast" ? { speedNote: `fast requested, served ${speed}` } : {}),
    },
  };
}

/** A failed call as a debug response. */
export function errorResponseInfo(target: LlmPrompt["target"], t0: number, err: unknown): LlmResponse {
  return { target, durationMs: Math.round(performance.now() - t0), error: redactImagePayloads(err instanceof Error ? err.message : String(err)) as string };
}

// ── Spoken language ─────────────────────────────────────────────────────────

const LANGUAGE_NAMES: Record<string, string> = { en: "English", ro: "Romanian" };
export const languageName = (code: string): string => LANGUAGE_NAMES[code] ?? code;
/** A per-turn instruction line when the user didn't speak English ("" otherwise). */
export function languageLine(language: string | undefined, what: string): string {
  return language ? `The user spoke ${languageName(language)}: write ${what} in ${languageName(language)}.` : "";
}

// ── Role prompts ────────────────────────────────────────────────────────────

/** The router's output format: one JSON object, written as text. */
const ROUTER_FORMAT = `

## Output format
Reply with ONLY one JSON object (no code fences, no other text), keys in exactly this order:
{"intent": "question" | "task" | "clarify" | "answer", "estimate_seconds": <integer or null>, "say": "<what to speak now>", "question": "<the delegated request, or empty>"}
"intent" and "estimate_seconds" come first because the reply is streamed and acted on as it arrives.`;

const FILLERS_FORMAT = `

## Output format
Reply with ONLY one JSON object (no code fences, no other text): {"lines": ["…", "…", "…"], "cut_in": "…"}`;

/** Added to the solver's system prompt when it works in the project folder (Claude Code's tool names). */
const PROJECT_NOTE = `Your working directory is the project you're answering about. Find the code behind the pointed elements with Glob, Grep and Read: start from the \`selector\` line (tag, ids, classes, text), then read the markup, CSS and script that render it, and the project's DECISIONS.md. Read and edit only inside the working directory, and don't describe a file you haven't read. For a change request, make the change with Edit or Write, keep it to what was asked, and read the file back to check it. Never read or edit .env files. Without a shell you can't run git, and the files under .git/ are compressed: don't read them or hunt for other copies of a file. Use the request's git state block (status, recent commits, uncommitted changes), and say plainly when an answer needs history it doesn't show.`;
/** Added to the solver's system prompt when there's no project folder (no tools). */
const NO_TOOLS_NOTE = `You have no tools in this session: no files, no shell, no web. Answer from the request and the conversation alone, in the format above, and never write a tool call.`;
/** PROJECT_NOTE for the other harnesses (their file tools have other names). */
const PROJECT_NOTE_ANY_HARNESS = PROJECT_NOTE
  .replace("with Glob, Grep and Read", "with your file search and read tools")
  .replace("make the change with Edit or Write", "make the change with your file editing tools");

const readText = (p: string): string => readFileSync(join(SERVER_DIR, p), "utf8");

/** router.md's threads section starts here: it goes in the turn's message (threads mode), not the system prompt. */
const THREADS_MARKER = "<!-- threads";

let cachedPrompts: { router: string; routerThreads: string; solver: string; fillers: string } | null = null;
function prompts(): { router: string; routerThreads: string; solver: string; fillers: string } {
  return (cachedPrompts ??= (() => {
    const router = readText("prompts/router.md");
    const i = router.indexOf(THREADS_MARKER);
    return {
      router: (i < 0 ? router : router.slice(0, i)).trim(),
      routerThreads: i < 0 ? "" : router.slice(router.indexOf("\n", i) + 1).trim(),
      solver: readText("prompts/solver.md").trim(),
      fillers: readText("prompts/fillers.md").trim(),
    };
  })());
}

/** Each role's system prompt on a harness; the solver works in the project folder when there is one. */
export function roleSystem(role: CliRole, harness: LlmProvider): { system: string; project?: string } {
  if (role === "router") return { system: routerSystem() + ROUTER_FORMAT };
  if (role === "fillers") return { system: prompts().fillers + FILLERS_FORMAT };
  const dir = projectDir();
  // Without tools, say so: otherwise models write a tool call as text (the solver in Claude Code then stalls on it).
  if (!dir) return { system: `${prompts().solver}\n\n${NO_TOOLS_NOTE}` };
  return { system: `${prompts().solver}\n\n${harness === "claude-code" ? PROJECT_NOTE : PROJECT_NOTE_ANY_HARNESS}`, project: dir };
}
registerRoleSpecs(roleSystem);

/** The tier's choice for a role (the default when a caller gives none). */
const choiceFor = (llm: LlmChoice | undefined, role: CliRole): LlmChoice => llm ?? DEFAULT_CONFIG.llm[ROLE_TIER[role]];

/**
 * One fast-tier request (router, progress lines): on a model API with the role's system prompt and the real
 * messages, or on a warm harness agent with the messages flattened into one.
 */
function fastRequest(
  role: "router" | "fillers", choice: LlmChoice, params: ChatParams, onText: ((d: string) => void) | undefined, timeoutMs: number,
): Promise<HarnessResult> {
  const provider = choice.provider;
  return isApiProvider(provider)
    ? apiRequest(provider, choice, { system: roleSystem(role, provider).system, messages: params.messages, annotations: params.annotations }, onText, timeoutMs)
    : harnessRequest(role, choice, flattenMessages(params), onText, timeoutMs, undefined, params.annotations);
}

export class ClaudeRefusalError extends Error {
  constructor(readonly model: string, readonly category: string | null, readonly explanation: string | null) {
    super(`${model} refused (stop_reason: "refusal"${category ? `, category: ${category}` : ""})`);
    this.name = "ClaudeRefusalError";
  }
}

// ── Pointing formatter ──────────────────────────────────────────────────────

const ALGO_PREFERENCE = ["dwellMode", "dwell", "mode", "atStart"];

/**
 * One line per pointing word, using the preferred algorithm's pick:
 * `Pointing: "this" → <div> "Feature card grid" [data-source=web/cursor/demo/demo.html:34]`
 */
export function formatPointingForPrompt(targets: PointingTarget[], opts: { selectors?: boolean } = {}): string {
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
    const line = formatPointingLine({ ...best, word: best.word.replace(/[^\p{L}\p{N}'-]/gu, "") });
    // The CSS selector that matches the element on the live page: the handle the solver uses to find its markup.
    const selector = opts.selectors ? best.sample?.elementPath : null;
    lines.push(selector ? `${line}\n   selector: ${selector}` : line);
  }
  return lines.length ? lines.join("\n") : "Pointing: none (the user was not pointing at anything we could resolve)";
}

// ── Router ───────────────────────────────────────────────────────────────────

/**
 * Estimates above this many seconds count as long tasks. The router prompt tells the user "this will take a
 * while" above it (the number is substituted into router.md's {{LONG_TASK_SECONDS}}). Keep it in sync with
 * `RunConfig.longTaskSeconds`' default; another threshold is given per turn.
 */
export const DEFAULT_LONG_TASK_SECONDS = 20;

const ROUTE_INTENTS_AUTO = ["question", "task", "clarify", "answer"] as const satisfies readonly RouteIntent[];
const ROUTE_INTENTS_FORCED = ["question", "task", "clarify"] as const satisfies readonly RouteIntent[];

export interface RouterInput { intent: RouteIntent; estimateS: number | null; say: string; question: string }

/** Earlier chat turns as alternating user/assistant messages (never empty content). */
export function historyMessages(history: ChatTurn[], forSolver: boolean): ChatMessage[] {
  return history.flatMap((t): ChatMessage[] => [
    { role: "user", content: (t.user || "(inaudible)") + (t.annotation ? `\n\n${drawingContext(t.annotation)}` : "") },
    {
      role: "assistant",
      // The solver answers in the SPOKEN:-first format; replay its own detailed answer when it gave one.
      content: (forSolver ? (t.detail ? trimDetail(t.detail) : `SPOKEN: ${t.assistant}`) : t.assistant) || "(no reply)",
    },
  ]);
}

/**
 * Validates the complete router JSON. question/task need a question; clarify/answer need something to say,
 * except a silent clarify (empty `say` and `question`): the transcript only described silence, so no reply.
 */
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
  if (!sayText && !(i === "clarify" && typeof question === "string" && !question.trim())) return null;
  return { intent: i, estimateS: null, say: sayText, question: "" };
}

function routerSystem(): string {
  return prompts().router.replaceAll("{{LONG_TASK_SECONDS}}", String(DEFAULT_LONG_TASK_SECONDS));
}

const MODE_LINE: Record<RouterMode, string> = {
  forced: "Mode: delegate. Never answer yourself: use question or task, or clarify if you'd have to guess.",
  auto: "Mode: auto. You may use answer for small talk or trivial things; otherwise question, task or clarify.",
};

/** Threads mode's output format: the thread fields between `estimate_seconds` and `say`. */
const THREADS_FORMAT = `Output format for this turn (instead of the one in your instructions), keys in exactly this order:
{"intent": "question" | "task" | "clarify" | "answer", "estimate_seconds": <integer or null>, "target": "new" | "<thread id>" | "central", "relation": "followup" | "correction" | null, "tell": "<thread id>" | null, "say": "<what to speak now>", "question": "<the delegated request, or empty>"}`;

/** One line per thread: `- t1: the 'Get started' button (running, under the cursor): Making it bigger.` */
export function formatThreadBriefs(threads: readonly ThreadBrief[]): string {
  if (!threads.length) return "Threads: none yet.";
  return ["Threads:", ...threads.map((t) => {
    const where = [t.state, ...(t.onCurrentPage ? [] : ["on another page"]), ...(t.underCursor ? ["under the cursor"] : [])].join(", ");
    return `- ${t.threadId}: ${t.title} (${where})${t.summary ? `: ${t.summary}` : ""}`;
  })].join("\n");
}

/** The threads block of the turn's message: rules, the pointed element, the threads, the output format. */
export function threadsBlock(
  threads: readonly ThreadBrief[], anchorLabel?: string, extra: { clicked?: boolean; typed?: boolean; chat?: boolean; panel?: string } = {},
): string {
  const where = extra.chat
    ? [`The user typed this in the conversation's message box and is not pointing at anything. It stays in the conversation: target is "central", even when it is about a thread (answer from the threads below, or use \`tell\` to read a thread's finished result). Never a thread id and never "new".`]
    : extra.typed
    ? [`The user typed this on the clicked element and did not speak. The marker stays on that click: target is "new" or that element's thread id. Do not target a different thread and do not use "central".`]
    : [
      ...(extra.panel ? [`The user is speaking with ${extra.panel}'s panel open. The turn stays on that thread: target is that thread's id.`] : []),
      ...(extra.clicked ? [`The user clicked this element while speaking. Place a marker on it (target "new" or its thread) unless they name a different existing thread.`] : []),
    ];
  return [
    prompts().routerThreads,
    `Pointed element this turn: ${anchorLabel ?? "none"}.`,
    ...where,
    formatThreadBriefs(threads),
    THREADS_FORMAT,
  ].join("\n\n");
}

export function buildRouterParams(
  transcript: string, pointing: PointingTarget[], mode: RouterMode, history: ChatTurn[] = [],
  extra: { pageContext?: string; longTaskSeconds?: number; language?: string; voiceCues?: boolean; threads?: ThreadBrief[]; anchorLabel?: string; clicked?: boolean; typed?: boolean; chat?: boolean; panel?: string } = {},
): ChatParams {
  // Per-turn context goes in the user message so the system prompt stays the same (warm agents start with it).
  const lines = [`${MODE_LINE[mode]}`, `Transcript: "${transcript}"`, formatPointingForPrompt(pointing)];
  if (extra.pageContext) lines.push(extra.pageContext);
  const lang = languageLine(extra.language, "`say` (and a clarifying question)");
  if (lang) lines.push(lang);
  if (extra.voiceCues) lines.push(FISH_ACK_CUES);
  if (extra.longTaskSeconds !== undefined && extra.longTaskSeconds !== DEFAULT_LONG_TASK_SECONDS) {
    lines.push(`Long-task threshold for this conversation: ${extra.longTaskSeconds} seconds (use it instead of ${DEFAULT_LONG_TASK_SECONDS}).`);
  }
  if (extra.threads) lines.push("", threadsBlock(extra.threads, extra.anchorLabel, { clicked: extra.clicked, typed: extra.typed, chat: extra.chat, panel: extra.panel }));
  return { messages: [...historyMessages(history, false), { role: "user", content: lines.join("\n") }] };
}

/**
 * Threads mode: the complete router JSON validated like validateRouterInput (any mode's intents; `answer` is
 * checked by resolveThreadRoute), plus a `tell` answer, whose `say` may be empty (the server speaks the result).
 */
function validateThreadsInput(v: unknown, ctx: ThreadRouteContext): RouterInput | null {
  const input = validateRouterInput(v, "auto");
  if (input) return input;
  const { intent, tell } = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  if (intent === "answer" && typeof tell === "string" && ctx.threadIds.includes(tell)) return { intent: "answer", estimateS: null, say: "", question: "" };
  return null;
}

export const routeTurn: RouteTurn = async ({
  mark, transcript, pointing, mode, history, pageContext, longTaskSeconds, language, voiceCues, onDecision, onSpokenDelta, onSpokenEnd, onPrompt, onResponse, llm,
  threads, anchorLabel, clicked, typed, chat, panel, annotation,
}) => {
  const choice = choiceFor(llm, "router");
  const params = attachDrawing(buildRouterParams(transcript, pointing, mode, history, { pageContext, longTaskSeconds, language, voiceCues, threads, anchorLabel, clicked, typed, chat, panel }), annotation, history);
  onPrompt?.(harnessPromptInfo("router", choice, params));
  const ctx: ThreadRouteContext | null = threads
    ? { threadIds: threads.map((t) => t.threadId), pointed: !!anchorLabel, forced: mode === "forced" }
    : null;
  const route = new RouteInputStream(
    {
      onDecision: (d) => onDecision?.(d),
      onSay: (d, kind) => onSpokenDelta(d, kind),
      onSayEnd: (kind) => onSpokenEnd?.(kind),
    },
    // Threads mode: `answer` streams in any mode (a tell); resolveThreadRoute turns a forced-mode answer without it into clarify.
    mode === "forced" && !ctx ? ROUTE_INTENTS_FORCED : ROUTE_INTENTS_AUTO,
    mode === "forced" ? "clarify" : "answer",
    ctx ? (intent, raw) => resolveThreadRoute(intent, raw, ctx) : undefined,
  );
  let firstToken = false;
  let started = false;
  let json = "";

  mark("llm.request", { model: choice.model, mode, backend: choice.provider });
  const t0 = performance.now();
  let res: HarnessResult | null = null;
  let streamError: unknown = null;
  try {
    // The JSON is fed to the stream parser from its first "{" (models sometimes open with a code fence).
    res = await fastRequest("router", choice, params, (d) => {
      if (!firstToken) { firstToken = true; mark("llm.firstToken"); }
      let chunk = d;
      if (!started) {
        const i = chunk.indexOf("{");
        if (i < 0) return;
        started = true;
        chunk = chunk.slice(i);
        mark("llm.toolCall", { name: "route (json text)" });
      }
      json += chunk;
      route.feed(chunk);
    }, ROLE_TIMEOUT_MS.router);
    json = extractJsonObject(json) ?? json;
    onResponse?.(harnessResponseInfo("router", t0, res, choice));
  } catch (err) {
    onResponse?.(errorResponseInfo("router", t0, err));
    // Nothing usable arrived: the failure is the turn's. Otherwise degrade below with what streamed.
    if (!started) throw err;
    streamError = err;
  }

  if (res?.stopReason === "refusal") throw new ClaudeRefusalError(res.model, null, null);
  const usage = res?.usage ?? null;
  if (usage) logUsage("router", usage, res?.model);

  let parsed: unknown = null;
  if (!streamError && res?.stopReason !== "max_tokens" && json) {
    try { parsed = JSON.parse(json); } catch { parsed = null; }
  }
  const input = ctx ? validateThreadsInput(parsed, ctx) : validateRouterInput(parsed, mode);

  if (input) {
    route.finish({ ...(parsed as RouteFields), intent: input.intent });
    let decision: RouteDecision = { intent: input.intent, estimateS: input.estimateS };
    if (ctx) {
      const t = resolveThreadRoute(input.intent, parsed as RouteFields, ctx);
      decision = { intent: t.intent, estimateS: kindFor(t.intent) === "ack" ? input.estimateS : null, target: t.target, ...(t.tell ? { tell: t.tell } : {}) };
    }
    const streamed = route.decision!;
    if (
      streamed.intent !== decision.intent || streamed.estimateS !== decision.estimateS ||
      JSON.stringify(streamed.target) !== JSON.stringify(decision.target) || streamed.tell !== decision.tell
    ) {
      log(`[claude] router: streamed decision ${JSON.stringify(streamed)} differs from final ${JSON.stringify(decision)}`);
    }
    if (decision.intent === "question" || decision.intent === "task") {
      return { delegate: { question: input.question, intent: decision.intent, estimateS: input.estimateS }, decision, usage };
    }
    return { delegate: null, decision, usage };
  }

  // Invalid or truncated output.
  const why = streamError ? `error: ${streamError instanceof Error ? streamError.message : String(streamError)}` : `stop_reason=${res?.stopReason ?? "?"}`;
  const streamed = route.decision;
  if (streamed?.tell) {
    // A tell needs nothing more than its decision.
    log(`[claude] router output invalid after a tell (${why}); keeping it`);
    route.finish();
    return { delegate: null, decision: streamed, usage };
  }
  if (streamed && kindFor(streamed.intent) === "answer" && route.sayComplete && route.spoken.trim()) {
    // The reply (a follow-up question or a direct answer) was complete and already spoken; only the tail broke.
    log(`[claude] router output invalid after a complete ${streamed.intent} (${why}); keeping it`);
    route.finish();
    return { delegate: null, decision: streamed, usage };
  }
  if (!transcript.trim()) {
    log(`[claude] router output invalid (${why}) and the transcript is empty; nothing to delegate`);
    route.finish({ intent: "clarify" });
    return { delegate: null, decision: route.decision!, usage };
  }
  // Degrade gracefully: delegate the raw transcript + pointing (keeping a question/task decision already announced).
  log(`[claude] router output invalid (${why}); delegating raw transcript`);
  route.finish({ intent: "question" });
  const d = route.decision!;
  const decision: RouteDecision = kindFor(d.intent) === "ack"
    ? d
    : { intent: "question", estimateS: null, ...(d.target ? { target: d.target } : {}) };
  return {
    delegate: { question: `${transcript}\n${formatPointingForPrompt(pointing)}`, intent: decision.intent as Intent, estimateS: decision.estimateS },
    decision,
    usage,
  };
};

// ── Progress lines (spoken while the solver works on a short task) ──────────

export function buildFillersParams(
  transcript: string, question: string, intent: Intent, pointing: PointingTarget[], language?: string, voiceCues = false,
): ChatParams {
  const lang = languageLine(language, "the lines");
  const cues = voiceCues ? `\n\n${FISH_FILLER_CUES}` : "";
  return {
    messages: [{
      role: "user",
      content: `Intent: ${intent === "task" ? "task (the user wants something changed)" : "question (the user wants information)"}\nUser said: "${transcript}"\nRequest passed to the colleague: ${question}\n${formatPointingForPrompt(pointing)}${lang ? `\n${lang}` : ""}${cues}`,
    }],
  };
}

const MAX_FILLERS = 3;
const MAX_CUT_IN_CHARS = 100;

export const generateFillers: GenerateFillers = async ({ transcript, question, intent, pointing, language, voiceCues, onPrompt, onResponse, llm }) => {
  const t0 = performance.now();
  const choice = choiceFor(llm, "fillers");
  try {
    const params = buildFillersParams(transcript, question, intent, pointing, language, voiceCues);
    onPrompt?.(harnessPromptInfo("fillers", choice, params));
    const res = await fastRequest("fillers", choice, params, undefined, ROLE_TIMEOUT_MS.fillers);
    onResponse?.(harnessResponseInfo("fillers", t0, res, choice));
    let parsed: { lines?: unknown; cut_in?: unknown } | null = null;
    try { parsed = JSON.parse(extractJsonObject(res.text) ?? "null"); } catch { parsed = null; }
    const lines = (Array.isArray(parsed?.lines) ? parsed.lines : [])
      .filter((l): l is string => typeof l === "string").map((l) => l.trim()).filter(Boolean).slice(0, MAX_FILLERS);
    if (!lines.length) log(`[claude] progress lines (${choice.provider}): no usable lines in ${JSON.stringify(res.text.slice(0, 120))}`);
    const cutIn = typeof parsed?.cut_in === "string" ? parsed.cut_in.trim() : "";
    // A long one isn't a cut-in any more: the pipeline's own one is used instead.
    return { lines, ...(cutIn && cutIn.length <= MAX_CUT_IN_CHARS ? { cutIn } : {}), usage: res.usage ?? null };
  } catch (err) {
    onResponse?.(errorResponseInfo("fillers", t0, err));
    log(`[claude] progress lines failed: ${err instanceof Error ? err.message : String(err)}`);
    return { lines: [], usage: null };
  }
};

// ── Solver ───────────────────────────────────────────────────────────────────

/** The last user message for the solver. Tasks are framed as change requests here, so the system prompt never changes. */
export function solverUserMessage(
  question: string, pointing: PointingTarget[], intent: Intent = "question", pageContext?: string, language?: string, voiceCues = false,
): string {
  const lang = languageLine(language, "the SPOKEN line and the detailed answer");
  const cues = voiceCues ? `\n\n${FISH_SOLVER_CUES}` : "";
  const pointed = `Pointing context (from the user's cursor):\n${formatPointingForPrompt(pointing, { selectors: true })}${pageContext ? `\n${pageContext}` : ""}${lang ? `\n\n${lang}` : ""}${cues}`;
  if (intent === "task") {
    return `Request type: TASK. This is a change request: the user wants something changed. If you have file tools, make the change in the project and report it in the task format. If you don't, describe the change you would make, using the task format.\n\nTask: ${question}\n\n${pointed}`;
  }
  return `Question: ${question}\n\n${pointed}`;
}

export function buildSolverParams(
  question: string, pointing: PointingTarget[], history: ChatTurn[] = [], intent: Intent = "question",
  pageContext?: string, language?: string, voiceCues = false,
): ChatParams {
  return {
    messages: [...historyMessages(history, true), { role: "user", content: solverUserMessage(question, pointing, intent, pageContext, language, voiceCues) }],
  };
}

export const solveTask: SolveTask = async ({ mark, question, pointing, history, intent, onSpokenLine, onDelta, pageContext, onPrompt, onResponse, language, voiceCues, llm, signal, timeoutMs, annotation }) => {
  const t0 = performance.now();
  const choice = choiceFor(llm, "solver");
  let text = "";
  let firstToken = false;
  let spokenReady = false;
  const parser = new SpokenLineParser((line, viaPrefix) => {
    spokenReady = true;
    mark("solver.spokenReady", { viaPrefix });
    onSpokenLine(line);
  });
  const params = attachDrawing(buildSolverParams(question, pointing, history, intent, pageContext, language, voiceCues), annotation, history);
  const git = await gitContext(projectDir());
  if (git) params.messages.at(-1)!.content += `\n\n${git}`;
  onPrompt?.(harnessPromptInfo("solver", choice, params));
  mark("solver.request", {
    model: choice.model, backend: choice.provider, fast: choice.speed === "fast",
    ...(choice.level ? { level: choice.level } : {}), ...(intent === "task" ? { intent } : {}),
  });
  const onText = (d: string): void => {
    if (!firstToken) { firstToken = true; mark("solver.firstToken"); }
    text += d;
    onDelta(d);
    parser.feed(d);
  };
  // Every harness can narrate before its final answer, including Claude Code.
  // Hold that narration so the fallback parser cannot announce it as the result.
  const gate = new NarrationGate(onText);
  let res: HarnessResult;
  try {
    res = await harnessRequest("solver", choice, flattenMessages(params), (d) => gate.feed(d), timeoutMs ?? ROLE_TIMEOUT_MS.solver, signal, params.annotations);
    gate.end();
  } catch (err) {
    onResponse?.(errorResponseInfo("solver", t0, err));
    throw err;
  }
  onResponse?.(harnessResponseInfo("solver", t0, res, choice));

  if (!spokenReady) parser.end();
  const usage = res.usage as { speed?: string; cache_read_input_tokens?: number } | null;
  mark("solver.done", { stopReason: res.stopReason, speed: usage?.speed ?? null, cacheReadInputTokens: usage?.cache_read_input_tokens ?? 0 });
  logUsage("solver", res.usage, res.model);

  if (res.stopReason === "refusal") throw new ClaudeRefusalError(res.model, null, null);
  if (res.stopReason === "max_tokens") log(`[claude] solver hit its output limit; answer is truncated`);
  return { text, usage: res.usage };
};

// ── Solver on an element thread (docs/PLAN-threads.md) ───────────────────────

/** The pointing block of a follow-up, when the user pointed at something ("" otherwise). */
function pointedTail(pointing: PointingTarget[], pageContext?: string, language?: string, voiceCues = false): string {
  const lang = languageLine(language, "the SPOKEN line and the detailed answer");
  const parts = [
    ...(pointing.length ? [`Pointing context (from the user's cursor):\n${formatPointingForPrompt(pointing, { selectors: true })}`] : []),
    ...(pageContext ? [pageContext] : []), ...(lang ? [lang] : []), ...(voiceCues ? [FISH_SOLVER_CUES] : []),
  ];
  return parts.length ? `\n\n${parts.join("\n\n")}` : "";
}

/**
 * The message for one request on a thread (its session holds the history). request: the solver's usual message.
 * followup: more feedback on the same element. correction: replaces the earlier instruction. reconcile: `question`
 * is a system note to act on.
 */
export function threadUserMessage(
  kind: "request" | "followup" | "correction" | "reconcile" | "direct", question: string, pointing: PointingTarget[], intent: Intent = "question",
  pageContext?: string, language?: string, voiceCues = false,
): string {
  const tail = pointedTail(pointing, pageContext, language, voiceCues);
  switch (kind) {
    case "request": return solverUserMessage(question, pointing, intent, pageContext, language, voiceCues);
    case "followup":
      return intent === "task"
        ? `Follow-up on the same element (more feedback from the user; build on what you did so far). Request type: TASK: make the change and report it in the task format.\n\nTask: ${question}${tail}`
        : `Follow-up on the same element (a further question from the user; what you found so far still applies).\n\nQuestion: ${question}${tail}`;
    case "direct":
      return `Follow-up on the same element, in the user's own words. If it asks for a change, it's Request type: TASK: make the change and report it in the task format. Otherwise answer it.\n\nUser: ${question}${tail}`;
    case "correction":
      return `Correction: the user changed their mind about this element. This replaces their previous instruction: ${question}\n\nMake the final state match this request: adjust or undo what you already changed for the previous instruction where it no longer applies. Report it in the task format (SPOKEN line first, past tense).${tail}`;
    case "reconcile":
      return `System note (not from the user): ${question}\n\nReply in the usual format: the SPOKEN line first (one short sentence: whether your change is intact, or what you fixed), then the details.`;
  }
}

/** The thread's harness choice, when its implementation exposes one (picks the NarrationGate and the debug labels). */
const threadChoice = (thread: { choice?: LlmChoice }): LlmChoice | undefined => thread.choice;

export const solveInThread: SolveInThread = async ({
  thread, kind, mark, question, pointing, intent, onSpokenLine, onDelta, pageContext, onPrompt, onResponse, language, voiceCues, timeoutMs, annotation,
}) => {
  const t0 = performance.now();
  const choice = threadChoice(thread);
  let text = "";
  let firstToken = false;
  let spokenReady = false;
  const parser = new SpokenLineParser((line, viaPrefix) => {
    spokenReady = true;
    mark("solver.spokenReady", { viaPrefix });
    onSpokenLine(line);
  });
  const git = await gitContext(projectDir());
  const user = threadUserMessage(kind, question, pointing, intent, pageContext, language, voiceCues) + (annotation ? `\n\n${drawingContext(annotation)}` : "") + (git ? `\n\n${git}` : "");
  const params: ChatParams = { messages: [{ role: "user", content: user }], ...(annotation ? { annotations: [annotation] } : {}) };
  if (onPrompt) {
    const info: LlmPrompt = choice
      ? harnessPromptInfo("solver", choice, params)
      : { target: "solver", model: "the thread's session", system: [], messages: [{ role: "user", text: user }] };
    onPrompt({
      ...info,
      messages: [{ role: "user", text: user, label: `thread ${kind} (the session holds the history)` }],
      settings: { ...info.settings, thread: thread.id, live: thread.live },
    });
  }
  mark("solver.request", {
    ...(choice ? { model: choice.model, backend: choice.provider, fast: choice.speed === "fast", ...(choice.level ? { level: choice.level } : {}) } : {}),
    thread: thread.id, kind, ...(intent === "task" ? { intent } : {}),
  });
  const onText = (d: string): void => {
    if (!firstToken) { firstToken = true; mark("solver.firstToken"); }
    text += d;
    onDelta(d);
    parser.feed(d);
  };
  // Thread sessions can narrate before the final SPOKEN line with any provider.
  const gate = new NarrationGate(onText);
  let res: Awaited<ReturnType<typeof thread.send>>;
  try {
    res = await thread.send(user, (d) => gate.feed(d), timeoutMs ?? ROLE_TIMEOUT_MS.solver, params.annotations);
    gate.end();
  } catch (err) {
    onResponse?.(errorResponseInfo("solver", t0, err));
    throw err;
  }
  const info = harnessResponseInfo("solver", t0, res, choice ?? { provider: "claude-code", model: res.model });
  onResponse?.({ ...info, raw: { ...(info.raw as object), thread: thread.id, reopened: res.reopened, filesTouched: res.filesTouched } });

  if (!spokenReady) parser.end();
  const usage = res.usage as { speed?: string; cache_read_input_tokens?: number } | null;
  mark("solver.done", { stopReason: res.stopReason, speed: usage?.speed ?? null, cacheReadInputTokens: usage?.cache_read_input_tokens ?? 0 });
  logUsage(`solver (thread ${thread.id})`, res.usage, res.model);

  if (res.stopReason === "refusal") throw new ClaudeRefusalError(res.model, null, null);
  if (res.stopReason === "max_tokens") log(`[claude] solver hit its output limit; answer is truncated`);
  return { text, usage: res.usage, filesTouched: res.filesTouched };
};

function logUsage(who: string, usage: unknown, model?: string): void {
  const u = (usage ?? {}) as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null; speed?: string | null };
  log(
    `[claude] ${who}${model ? ` (${model})` : ""} usage: input=${u.input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0} ` +
      `cache_write=${u.cache_creation_input_tokens ?? 0} output=${u.output_tokens ?? 0}${u.speed ? ` speed=${u.speed}` : ""}`,
  );
}
