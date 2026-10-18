// Conversation memory for chat mode (RunConfig.memory). One log per server process (the central conversation of
// docs/PLAN-threads.md), shared by every connection, so a reloaded sidebar picks up where it left off. Gone when the app closes.
import type { Approach } from "../shared/config.ts";
import type { ConnectionCache } from "./orchestrators/types.ts";

export interface ChatTurn {
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
/** Long the solver answers are trimmed when replayed as history. */
export const DETAIL_MAX_CHARS = 2000;

/** The process-level log. `conn` is accepted for older callers and ignored. */
export function getConversation(_conn?: ConnectionCache): ChatTurn[] {
  return central;
}

/** Forget the conversation ("New conversation"; tests). */
export function resetConversation(_conn?: ConnectionCache): void {
  central = [];
}

export const trimDetail = (s: string): string => (s.length > DETAIL_MAX_CHARS ? `${s.slice(0, DETAIL_MAX_CHARS)}…` : s);
