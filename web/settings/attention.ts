// What needs attention in the setup: a model tier whose harness isn't installed or whose API has no key, a speech
// model missing its key or install (or still loading), a required macOS permission not granted, an API key macOS
// wouldn't decrypt. The Settings Dashboard lists these (web/settings/main.ts), and so does the chat sidebar
// (web/chat/attention.ts) so they're in view on the first run without opening Settings. No DOM here.
import type { HarnessScan, LlmChoice, LlmTier } from "../../shared/config.ts";
import type { EngineState, InstallState } from "../../shared/protocol.ts";
import { STT_ROWS, TTS_ROWS, rowNotes, voiceNotes, type ModelRow, type RowContext, type RowNote, type SpeechKind } from "./speechModels.ts";

export type Tone = "ok" | "bad" | "warn" | "busy";
export type Section = "dashboard" | "models" | "stt" | "tts" | "keyboard" | "permissions" | "debugging" | "cookies" | "keys";
export const SECTIONS: readonly Section[] = ["dashboard", "models", "stt", "tts", "keyboard", "permissions", "debugging", "cookies", "keys"];
export const SECTION_LABELS: Record<Section, string> = {
  dashboard: "Dashboard", models: "Models", stt: "Speech to text (STT)", tts: "Text to speech (TTS)", keyboard: "Keyboard", permissions: "Permissions",
  debugging: "Debugging", cookies: "Browser cookies", keys: "API Keys",
};
export const isSection = (s: unknown): s is Section => (SECTIONS as readonly unknown[]).includes(s);

/** One thing to fix (or wait for). `focusKey`: the API key field it's about. */
export interface Problem { tone: Tone; text: string; section: Section; focusKey?: string }
export interface PermissionRow { id: string; name: string; ok: boolean; optional?: boolean; summary: string; instruction: string; action?: { id: string; label: string } }
export type ProviderInfo = Omit<HarnessScan, "models" | "error">;
/** The picked speech model and what its row says. */
export interface SpeechStatus { row: ModelRow; notes: RowNote[]; voice?: string }

export const SERVER_DOWN: Problem = { tone: "bad", text: "The voice server isn't running: quit and reopen the app.", section: "models" };

/** The tier's harness isn't installed, or its API has no key. */
export function tierProblems(tier: LlmTier, choice: LlmChoice, providers: readonly ProviderInfo[]): Problem[] {
  const p = providers.find((x) => x.id === choice.provider);
  if (!p || p.available) return [];
  return [{ tone: "bad", text: `${tier === "fast" ? "Fast" : "Smart"} tier: ${p.label} ${p.api ? "has no API key" : "isn't installed"}${p.note ? ` (${p.note})` : ""}.`, section: "models" }];
}

/** The picked speech model's notes that aren't fine: errors, what's loading, warnings. */
export function speechProblems(kind: SpeechKind, st: SpeechStatus | undefined): Problem[] {
  if (!st) return [];
  const label = kind === "stt" ? "Speech to text" : "Text to speech";
  return st.notes.filter((n) => n.tone !== "muted" && n.tone !== "ok").map((n) => ({
    tone: n.tone === "error" ? "bad" : n.tone === "loading" ? "busy" : "warn",
    text: `${label} (${st.row.name}): ${n.text}`,
    section: kind,
    ...(n.focus ? { focusKey: n.focus } : {}),
  }));
}

export function permissionProblems(rows: readonly PermissionRow[] | undefined): Problem[] {
  return (rows ?? []).filter((r) => !r.ok && !r.optional).map((r) => ({ tone: "bad", text: `${r.name}: ${r.summary}. ${r.instruction}`, section: "permissions" }));
}

export function keyProblems(unreadable: readonly string[], keyLabel: (key: string) => string): Problem[] {
  if (!unreadable.length) return [];
  return [{ tone: "bad", text: `Couldn't decrypt the saved ${unreadable.map(keyLabel).join(", ")}: enter ${unreadable.length === 1 ? "it" : "them"} again.`, section: "keys" }];
}

/** Failures first, then what's loading, then warnings. */
export function sortProblems(problems: readonly Problem[]): Problem[] {
  const order: Record<Tone, number> = { bad: 0, busy: 1, warn: 2, ok: 3 };
  return [...problems].sort((a, b) => order[a.tone] - order[b.tone]);
}

/** The one verdict over the problems: red with a count when something fails, grey while something loads, else green. */
export function verdict(problems: readonly Problem[]): { tone: Tone; title: string } {
  const bad = problems.filter((p) => p.tone === "bad").length;
  if (bad) return { tone: "bad", title: `${bad} thing${bad === 1 ? " needs" : "s need"} attention` };
  if (problems.some((p) => p.tone === "busy")) return { tone: "busy", title: "Starting up…" };
  return { tone: "ok", title: "Everything works" };
}

/**
 * The picked speech model's status from the server's engine and install states, for a page that doesn't draw the
 * speech lists (the chat sidebar). Settings has the same from its rows (web/settings/speechView.ts).
 */
export function speechStatusOf(kind: SpeechKind, model: string, ctx: Omit<RowContext, "selected" | "install"> & { installs?: readonly InstallState[] },
  keyLabel: (key: string) => string): SpeechStatus | undefined {
  const row = (kind === "stt" ? STT_ROWS : TTS_ROWS).find((r) => r.id === model);
  if (!row) return undefined;
  const install = row.engine ? ctx.installs?.find((i) => i.kind === kind && i.engine === row.engine) : undefined;
  const notes = rowNotes(row, { ...ctx, selected: true, install }, keyLabel);
  notes.push(...voiceNotes(install, (v) => v));
  return { row, notes };
}

export type { EngineState, InstallState };
