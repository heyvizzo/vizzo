// Smoke test for the Claude adapter: real API calls, prints marks with ms timings.
// Runs the Haiku router on several transcripts (pointing, no pointing, auto mode, a two-turn follow-up)
// and prints the decision, the spoken `say` and the delegated question; then fillers for the first two
// cases and one Opus run on the change request (task intent).
// Uses OpenRouter when OPENROUTER_API_KEY is set (else ANTHROPIC_API_KEY). Without credentials it prints SKIP and exits 0.
// Pass --opus-cache to also run Opus twice more on the question (fast on, then standard again to show cache reads).
import "dotenv/config";
import { performance } from "node:perf_hooks";
import type { RouterMode } from "../shared/config.ts";
import type { MarkName } from "../shared/marks.ts";
import type { Intent, PointingTarget } from "../shared/protocol.ts";
import type { ChatTurn } from "../server/conversation.ts";
import {
  claudeProvider, DEFAULT_LONG_TASK_SECONDS, generateFillers, hasClaudeCredentials, modelId, routeWithHaiku, setLogger, solveWithOpus,
} from "../server/adapters/claude.ts";

if (!hasClaudeCredentials()) {
  console.log("SKIP smoke:claude: set OPENROUTER_API_KEY (or ANTHROPIC_API_KEY) in .env to run against the real API.");
  process.exit(0);
}
console.log(`provider: ${claudeProvider()} · models: ${modelId("claude-haiku-5-5")}, ${modelId("claude-opus-5-5")} · long task > ${DEFAULT_LONG_TASK_SECONDS} s`);

const target = (word: string, wordStart: number, elementPath: string, label: string, dataSource: string): PointingTarget => ({
  word, wordStart, algorithm: "dwellMode",
  sample: { t: 0, x: 640, y: 520, scrollX: 0, scrollY: 400, elementPath, dataSource, label },
});
const GRID = target("this", 0.38, "body > main > section#features > div.card-grid", "Feature card grid", "web/cursor/demo/demo.html:34");
const CTA = target("this", 0.3, "body > main#top > section.hero > button.cta", "Get started button", "web/cursor/demo/demo.html:27");

interface Case {
  id: string; expect: string; transcript: string; pointing: PointingTarget[]; mode: RouterMode; history?: ChatTurn[];
}
const turn = (user: string, assistant: string): ChatTurn => ({ turnId: "t0", approach: "pipeline", user, assistant, detail: "" });
const CASES: Case[] = [
  { id: "a", expect: "question, short", transcript: "Why is this section built with a grid?", pointing: [GRID], mode: "forced" },
  { id: "b", expect: "task, long", transcript: "Make this button bigger", pointing: [CTA], mode: "forced" },
  { id: "c", expect: "clarify", transcript: "Change it", pointing: [], mode: "forced" },
  { id: "d", expect: "answer (auto)", transcript: "Can you hear me?", pointing: [], mode: "auto" },
  {
    id: "e", expect: "task, resolved to Get started", transcript: "the first one", pointing: [], mode: "forced",
    history: [turn("Make the button bigger", "Which button, the Get started one or Sign up?")],
  },
];

setLogger((m) => console.log(`    ${m}`));

function timer(title: string) {
  const t0 = performance.now();
  console.log(`\n=== ${title} ===`);
  return (name: MarkName, meta?: Record<string, unknown>): void => {
    const ms = (performance.now() - t0).toFixed(0).padStart(6);
    console.log(`  ${ms} ms  ${name}${meta ? `  ${JSON.stringify(meta)}` : ""}`);
  };
}

const cacheRead = (u: unknown): number => (u as { cache_read_input_tokens?: number | null } | null)?.cache_read_input_tokens ?? 0;

async function router(c: Case): Promise<{ question: string; intent: Intent } | null> {
  const mark = timer(`router ${c.id} (${c.mode}): ${JSON.stringify(c.transcript)}${c.history ? " +history" : ""}${c.pointing.length ? " +pointing" : ""} · expect ${c.expect}`);
  const t0 = performance.now();
  const at = (): string => `${(performance.now() - t0).toFixed(0)} ms`;
  let spoken = "";
  let kind = "";
  const res = await routeWithHaiku({
    mark, transcript: c.transcript, pointing: c.pointing, mode: c.mode, history: c.history,
    onDecision: (d) => console.log(`  ${at().padStart(9)}  decision ${JSON.stringify(d)}`),
    onSpokenDelta: (d, k) => { spoken += d; kind = k; },
    onSpokenEnd: (k) => console.log(`  ${at().padStart(9)}  say end (${k})`),
  });
  console.log(`  decision: ${JSON.stringify(res.decision)}`);
  console.log(`  say (${kind}): ${JSON.stringify(spoken)}`);
  console.log(`  delegate: ${res.delegate ? JSON.stringify(res.delegate) : "null"}`);
  return res.delegate;
}

async function fillers(c: Case, d: { question: string; intent: Intent }): Promise<void> {
  const t0 = performance.now();
  console.log(`\n=== fillers ${c.id} (${d.intent}) ===`);
  const res = await generateFillers({ transcript: c.transcript, question: d.question, intent: d.intent, pointing: c.pointing });
  console.log(`  ${(performance.now() - t0).toFixed(0)} ms`);
  for (const l of res.lines) console.log(`  - ${JSON.stringify(l)}`);
  if (!res.lines.length) console.log("  (no lines)");
}

async function opus(question: string, pointing: PointingTarget[], intent: Intent, fast: boolean, label: string, print: boolean): Promise<number> {
  const mark = timer(`solver: Opus ${intent}, fast ${fast ? "on" : "off"}${label}`);
  const res = await solveWithOpus({
    mark, question, pointing, fast, intent,
    onSpokenLine: (line) => console.log(`  SPOKEN → ${JSON.stringify(line)}`),
    onDelta: () => {},
  });
  if (print) console.log(`  --- answer ---\n${res.text.replace(/^/gm, "  | ")}`);
  else console.log(`  answer: ${res.text.length} chars`);
  const reads = cacheRead(res.usage);
  console.log(`  cache_read_input_tokens: ${reads}`);
  return reads;
}

try {
  const delegates = new Map<string, { question: string; intent: Intent } | null>();
  for (const c of CASES) delegates.set(c.id, await router(c));
  for (const id of ["a", "b"]) {
    const d = delegates.get(id);
    if (d) await fillers(CASES.find((c) => c.id === id)!, d);
  }
  const task = delegates.get("b");
  if (task) await opus(task.question, CASES[1]!.pointing, task.intent, false, " (change request)", true);
  if (process.argv.includes("--opus-cache")) {
    const q = delegates.get("a")?.question ?? CASES[0]!.transcript;
    await opus(q, CASES[0]!.pointing, "question", false, " (run 1: writes cache)", false);
    await opus(q, CASES[0]!.pointing, "question", true, "", false);
    const reads = await opus(q, CASES[0]!.pointing, "question", false, " (run 2: should read cache)", false);
    console.log(reads > 0 ? `\nOK cache hit on second standard run: ${reads} tokens read from cache.` : "\nWARN no cache read on the second standard run.");
  }
} catch (err) {
  console.error("\nFAIL smoke:claude:", err);
  process.exit(1);
}
