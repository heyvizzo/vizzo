// The tier choices the Chat page last picked (harness, model, level, speed per tier), saved so the next start
// warms the same agents before the first turn. The page reads them back on load and sends every change
// (POST /api/llm/selection), which re-warms: the other agents are killed and the chosen ones started.
// File: $LLM_SELECTION_FILE, default ~/.config/vizzo/llm-selection.json: { version, fast, smart, notice? }.
// A file from before SELECTION_VERSION 2 is moved over once when it is read: the smart tier's switches go back to
// their (new) defaults, all on, so the solver runs with the user's whole harness setup. What that turned on is kept
// as `notice` until the user has seen it (GET /api/llm/notice, dismissed with POST); later choices are kept as made.
// First run (no file yet): the harnesses are scanned and the selection is set to what's installed (Claude Code's
// defaults when it is), so the app works without a visit to Settings.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_CONFIG, HARNESS_TOGGLES, LLM_DEFAULT_MODELS, LLM_PROVIDER_LABELS, SELECTION_VERSION, defaultLevel, isHarness, llmOf, migrateChoice, toggleOn,
  type HarnessScan, type HarnessToggle, type LlmChoice, type LlmTier,
} from "../shared/config.ts";
import { configureWarm } from "./adapters/warmPool.ts";

export type Selection = Record<LlmTier, LlmChoice>;

const file = (): string => process.env.LLM_SELECTION_FILE ?? join(homedir(), ".config", "vizzo", "llm-selection.json");

/** Warm agents are on unless WARM_AGENTS=0 (or the older CLAUDE_AGENTS=0), and never with fake vendors. */
export const warmEnabled = (): boolean =>
  process.env.FAKE_VENDORS !== "1" && process.env.WARM_AGENTS !== "0" && process.env.CLAUDE_AGENTS !== "0";

let current: Selection | null = null;

/** What the one-time move to SELECTION_VERSION 2 turned on for the solver, until the user dismisses it. */
export interface SelectionNotice { harness: string; turnedOn: string[] }
let notice: SelectionNotice | null = null;

/** A smart-tier choice from before version 2, moved over; and the switches that turned on with it (by label). */
export function migrateSelection(saved: Selection): { selection: Selection; notice: SelectionNotice | null } {
  const smart = migrateChoice("smart", saved.smart);
  const selection = { fast: saved.fast, smart };
  const h = saved.smart.provider;
  if (!isHarness(h)) return { selection, notice: null };
  // Before version 2 a switch was at its listed default unless chosen (HarnessToggle.default, mostly off).
  const wasOn = (t: HarnessToggle): boolean => saved.smart.toggles?.[t.id] ?? t.default;
  const turnedOn = HARNESS_TOGGLES[h].filter((t) => !wasOn(t) && toggleOn(h, smart.toggles, t.id, "smart")).map((t) => t.label);
  return { selection, notice: turnedOn.length ? { harness: LLM_PROVIDER_LABELS[h], turnedOn } : null };
}

function save(): void {
  try {
    mkdirSync(dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify({ version: SELECTION_VERSION, ...current, ...(notice ? { notice } : {}) }, null, 2) + "\n");
  } catch (e) {
    console.error(`[llm] couldn't save the selection: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The saved selection (the defaults if there's none or it can't be read), moved over once from an older version. */
export function currentSelection(): Selection {
  if (current) return current;
  let raw: (Partial<Selection> & { version?: number; notice?: SelectionNotice }) | null = null;
  try { raw = JSON.parse(readFileSync(file(), "utf8")); } catch { /* none yet, or unreadable */ }
  if (!raw) return (current = DEFAULT_CONFIG.llm);
  const saved = llmOf({ llm: raw as Selection });
  if ((raw.version ?? 1) < SELECTION_VERSION) {
    const m = migrateSelection(saved);
    current = m.selection;
    notice = m.notice;
    if (notice) console.log(`[llm] the solver's switches are on now (${notice.harness}: ${notice.turnedOn.join(", ")})`);
    save();
  } else {
    current = saved;
    notice = raw.notice?.turnedOn?.length ? raw.notice : null;
  }
  return current;
}

/** Save a new selection and warm its agents (the others are killed). */
export function setSelection(sel: Selection): Selection {
  currentSelection(); // an older file is moved over (and its notice kept) before it is replaced
  current = llmOf({ llm: sel });
  save();
  if (warmEnabled()) configureWarm(current);
  return current;
}

/** What the move to the new switch defaults turned on, if the user hasn't dismissed it yet. */
export function selectionNotice(): SelectionNotice | null {
  currentSelection();
  return notice;
}

/** The user has seen the notice. */
export function dismissSelectionNotice(): void {
  currentSelection();
  if (!notice) return;
  notice = null;
  save();
}

/** Tests: forget what was read. */
export function resetSelectionCache(): void { current = null; notice = null; }

/**
 * The first-run selection from a scan: Claude Code's defaults (DEFAULT_CONFIG.llm) when it's installed, else the
 * first installed harness on both tiers with its default model (when it lists it) and level, else the defaults.
 */
export function firstRunChoice(scan: Pick<HarnessScan, "id" | "available" | "api" | "models">[]): Selection {
  const usable = scan.filter((h) => !h.api && h.available && isHarness(h.id));
  if (usable.some((h) => h.id === "claude-code")) return DEFAULT_CONFIG.llm;
  const h = usable[0];
  if (!h) return DEFAULT_CONFIG.llm;
  const pick = (tier: LlmTier): LlmChoice => {
    const wanted = LLM_DEFAULT_MODELS[h.id][tier] ?? "";
    const model = !h.models.length || h.models.some((m) => m.id === wanted) ? wanted : "";
    const level = defaultLevel(h.models.find((m) => m.id === model), tier);
    return { provider: h.id, model, ...(level ? { level } : {}) };
  };
  return { fast: pick("fast"), smart: pick("smart") };
}

let firstRun: Promise<void> | null = null;

/**
 * No saved selection yet: scan the harnesses (which also fills the model lists Settings shows) and save the
 * first-run selection, which warms its agents. A selection saved meanwhile (Settings) is kept.
 * GET /api/llm/selection waits for this, so the windows show what was picked.
 */
function setUpFirstRun(): Promise<void> {
  firstRun ??= (async () => {
    const { providerStatus, scanHarnesses } = await import("./llmProviders.ts");
    const scanning = scanHarnesses().catch(() => []);
    // Claude Code installed: its defaults right away (the scan goes on, filling the model lists).
    const scan = providerStatus().some((p) => p.id === "claude-code" && p.available)
      ? [{ id: "claude-code" as const, available: true, models: [] }]
      : await scanning;
    if (existsSync(file())) return;
    const sel = firstRunChoice(scan);
    console.log(`[llm] first run: ${sel.fast.provider} ${sel.fast.model || "(default)"} / ${sel.smart.provider} ${sel.smart.model || "(default)"}`);
    setSelection(sel);
  })();
  return firstRun;
}

/** Waits for the first-run scan when one is going (GET /api/llm/selection answers with its result). */
export async function settledSelection(): Promise<Selection> {
  if (firstRun) await firstRun;
  return currentSelection();
}

/** Warm the saved selection's agents (server start, project folder change); on first run, set one up first. */
export function warmSaved(): void {
  if (process.env.FAKE_VENDORS !== "1" && !existsSync(file())) { void setUpFirstRun(); return; }
  if (warmEnabled()) configureWarm(currentSelection());
}
