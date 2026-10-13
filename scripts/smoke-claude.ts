// Smoke test for the Claude adapter (T6): real API calls, prints marks with ms timings.
// Runs the Haiku router (forced + auto) and Opus (fast off/on, then fast off again to show
// cache reads) on U3's transcript with a fake pointing target at the card grid.
// Uses OpenRouter when OPENROUTER_API_KEY is set (else ANTHROPIC_API_KEY). Without credentials it prints SKIP and exits 0.
import "dotenv/config";
import { performance } from "node:perf_hooks";
import type { MarkName } from "../shared/marks.ts";
import type { PointingTarget } from "../shared/protocol.ts";
import { claudeProvider, formatPointingForPrompt, hasClaudeCredentials, modelId, routeWithHaiku, setLogger, solveWithOpus } from "../server/adapters/claude.ts";

if (!hasClaudeCredentials()) {
  console.log("SKIP smoke:claude: set OPENROUTER_API_KEY (or ANTHROPIC_API_KEY) in .env to run against the real API.");
  process.exit(0);
}
console.log(`provider: ${claudeProvider()} · models: ${modelId("claude-haiku-5-5")}, ${modelId("claude-opus-5-5")}`);

const U3 = "Why is this section built with a grid instead of flexbox?";
const POINTING: PointingTarget[] = [{
  word: "this", wordStart: 0.38, algorithm: "dwellMode",
  sample: {
    t: 0, x: 640, y: 520, scrollX: 0, scrollY: 400,
    elementPath: "body > main > section#features > div.card-grid",
    dataSource: "web/cursor/demo/demo.html:34",
    label: "Feature card grid",
  },
}];

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

async function router(mode: "forced" | "auto"): Promise<string> {
  const mark = timer(`router: Haiku, ${mode}`);
  let spoken = "";
  const res = await routeWithHaiku({ mark, transcript: U3, pointing: POINTING, mode, onSpokenDelta: (d) => (spoken += d) });
  console.log(`  spoken:   ${JSON.stringify(spoken)}`);
  console.log(`  delegate: ${res.delegate ? JSON.stringify(res.delegate.question) : "null (answered directly)"}`);
  console.log(`  cache_read_input_tokens: ${cacheRead(res.usage)}`);
  return res.delegate?.question ?? `${U3}\n${formatPointingForPrompt(POINTING)}`;
}

async function opus(question: string, fast: boolean, label: string): Promise<number> {
  const mark = timer(`solver: Opus, fast ${fast ? "on" : "off"}${label}`);
  const res = await solveWithOpus({
    mark, question, pointing: POINTING, fast,
    onSpokenLine: (line) => console.log(`  SPOKEN → ${JSON.stringify(line)}`),
    onDelta: () => {},
  });
  console.log(`  answer: ${res.text.length} chars`);
  const reads = cacheRead(res.usage);
  console.log(`  cache_read_input_tokens: ${reads}`);
  return reads;
}

try {
  const question = await router("forced");
  await router("auto");
  await opus(question, false, " (run 1: writes cache)");
  await opus(question, true, "");
  const reads = await opus(question, false, " (run 2: should read cache)");
  console.log(reads > 0 ? `\nOK cache hit on second standard run: ${reads} tokens read from cache.` : "\nWARN no cache read on the second standard run.");
} catch (err) {
  console.error("\nFAIL smoke:claude:", err);
  process.exit(1);
}
