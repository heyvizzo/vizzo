import type { DrawingAnnotation } from "../shared/annotations.ts";
import { drawingContext } from "./adapters/drawing.ts";
// Conversation memory for chat mode (RunConfig.memory). One log per server process (the central conversation of
// docs/PLAN-threads.md), shared by every connection, so a reloaded sidebar picks up where it left off. Gone when the app closes.
// The solver works on it in one harness session of its own (server/centralSession.ts), which holds the history
// itself; this log is what the router is told, and what a session without the history is given as text.
import type { Approach } from "../shared/config.ts";
import type { ConnectionCache } from "./orchestrators/types.ts";

export interface ChatTurn {
  annotation?: DrawingAnnotation;
  turnId: string;
  approach: Approach;
  /** What the user said (Scribe transcript; may be empty if STT failed). */
  user: string;
  /** What the voice layer said aloud (ack + answer). */
  assistant: string;
  /** The solver's full answer (starts with `SPOKEN:`), if the turn was delegated. */
  detail: string;
}

let central: ChatTurn[] = [];
const resetHooks: (() => void)[] = [];

/** The process-level log. `conn` is accepted for older callers and ignored. */
export function getConversation(_conn?: ConnectionCache): ChatTurn[] {
  return central;
}

/** Forget the conversation ("New conversation"; tests). */
export function resetConversation(_conn?: ConnectionCache): void {
  central = [];
  for (const fn of resetHooks) {
    try { fn(); } catch (e) { console.warn("[conversation] reset hook failed", e); }
  }
}

/** Run `fn` whenever the conversation is forgotten (its harness session is closed then). */
export function onConversationReset(fn: () => void): void {
  resetHooks.push(fn);
}

/**
 * How much history a session without any of its own is given as text (characters; about 60k tokens). A harness
 * session holds its history itself and manages its own context window (it compacts when it has to), so this only
 * applies to the fallback: a session that couldn't be continued natively, or a one-off solver request. Whole turns
 * are kept, newest first; older ones are left out and the text says how many. $VIZZO_REPLAY_MAX_CHARS overrides it.
 */
export const REPLAY_MAX_CHARS = 240_000;
const replayBudget = (): number => {
  const n = Number(process.env.VIZZO_REPLAY_MAX_CHARS);
  return Number.isFinite(n) && n > 0 ? n : REPLAY_MAX_CHARS;
};

const turnChars = (t: ChatTurn): number => t.user.length + (t.detail || t.assistant).length + 40;

/**
 * The newest turns that fit the replay budget, whole (no answer is cut), and how many older ones were left out. The
 * latest turn is always kept, even alone over the budget.
 */
export function fitHistory(history: readonly ChatTurn[], budget = replayBudget()): { kept: ChatTurn[]; omitted: number } {
  let used = 0;
  let from = history.length;
  while (from > 0) {
    const size = turnChars(history[from - 1]!);
    if (from < history.length && used + size > budget) break;
    used += size;
    from--;
  }
  return { kept: history.slice(from), omitted: from };
}

/** The lines of a replay that fit the budget, newest kept, with a note of how many older ones were left out. */
export function fitLines(lines: readonly string[], budget = replayBudget()): string[] {
  let used = 0;
  let from = lines.length;
  while (from > 0) {
    const size = lines[from - 1]!.length + 2;
    if (from < lines.length && used + size > budget) break;
    used += size;
    from--;
  }
  return from ? [omittedNote(from, "entries"), ...lines.slice(from)] : [...lines];
}

const omittedNote = (n: number, what: string): string =>
  `(${n} earlier ${what} left out: the history is longer than fits here. The files as they are now show what was done.)`;

/**
 * Turns as text for the solver's session: each user line, then the solver's own answer in full (its SPOKEN line
 * when there was no detailed answer). A user line in parentheses is a note about other work, not something said.
 */
export function conversationText(turns: readonly ChatTurn[], heading: string): string {
  const { kept, omitted } = fitHistory(turns);
  if (!kept.length) return "";
  const body = kept.map((t) => {
    const user = (t.user || "(inaudible)") + (t.annotation ? `\n\n${drawingContext(t.annotation)}` : "");
    const reply = t.detail || (t.assistant ? `SPOKEN: ${t.assistant}` : "(no reply)");
    return `User: ${user}\n\nAssistant: ${reply}`;
  });
  return `${heading}\n\n${omitted ? `${omittedNote(omitted, "turns")}\n\n` : ""}${body.join("\n\n")}`;
}

/** The latest four distinct drawings remain available to central follow-ups; older geometry remains as text. */
export function retainConversationDrawings(): void {
  const retained = new Set<string>();
  for (const t of [...central].reverse()) {
    if (!t.annotation) continue;
    if (retained.has(t.annotation.id) || retained.size < 4) { retained.add(t.annotation.id); continue; }
    t.user += `\n\n[Drawing preview expired from retained history]\n${drawingContext(t.annotation)}`;
    delete t.annotation;
  }
}
