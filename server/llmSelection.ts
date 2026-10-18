// The tier choices the Chat page last picked (harness, model, level, speed per tier), saved so the next start
// warms the same agents before the first turn. The page reads them back on load and sends every change
// (POST /api/llm/selection), which re-warms: the other agents are killed and the chosen ones started.
// File: $LLM_SELECTION_FILE, default ~/.config/realtime-voice/llm-selection.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG, llmOf, type LlmChoice, type LlmTier } from "../shared/config.ts";
import { configureWarm } from "./adapters/warmPool.ts";

export type Selection = Record<LlmTier, LlmChoice>;

const file = (): string => process.env.LLM_SELECTION_FILE ?? join(homedir(), ".config", "realtime-voice", "llm-selection.json");

/** Warm agents are on unless WARM_AGENTS=0 (or the older CLAUDE_AGENTS=0), and never with fake vendors. */
export const warmEnabled = (): boolean =>
  process.env.FAKE_VENDORS !== "1" && process.env.WARM_AGENTS !== "0" && process.env.CLAUDE_AGENTS !== "0";

let current: Selection | null = null;

/** The saved selection (the defaults if there's none or it can't be read). */
export function currentSelection(): Selection {
  if (current) return current;
  try { current = llmOf({ llm: JSON.parse(readFileSync(file(), "utf8")) as Selection }); } catch { current = DEFAULT_CONFIG.llm; }
  return current;
}

/** Save a new selection and warm its agents (the others are killed). */
export function setSelection(sel: Selection): Selection {
  current = llmOf({ llm: sel });
  try {
    mkdirSync(dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify(current, null, 2) + "\n");
  } catch (e) {
    console.error(`[llm] couldn't save the selection: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (warmEnabled()) configureWarm(current);
  return current;
}

/** Warm the saved selection's agents (server start, project folder change). */
export function warmSaved(): void {
  if (warmEnabled()) configureWarm(currentSelection());
}
