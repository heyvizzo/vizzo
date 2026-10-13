// Conversation memory for chat mode (RunConfig.memory). One log per browser connection, shared by
// every approach, so switching A/B/C mid-conversation keeps the context.
import type { Approach } from "../shared/config.ts";
import type { ConnectionCache } from "./orchestrators/types.ts";

export interface ChatTurn {
  turnId: string;
  approach: Approach;
  /** What the user said (Scribe transcript; may be empty if STT failed). */
  user: string;
  /** What the voice layer said aloud (ack + answer). */
  assistant: string;
  /** Opus's full answer (starts with `SPOKEN:`), if the turn was delegated. */
  detail: string;
}

const KEY = "conversation";
/** Long Opus answers are trimmed when replayed as history. */
export const DETAIL_MAX_CHARS = 2000;

export function getConversation(conn: ConnectionCache): ChatTurn[] {
  let turns = conn.get<ChatTurn[]>(KEY);
  if (!turns) conn.set(KEY, (turns = []));
  return turns;
}

export function resetConversation(conn: ConnectionCache): void {
  conn.delete(KEY);
}

export const trimDetail = (s: string): string => (s.length > DETAIL_MAX_CHARS ? `${s.slice(0, DETAIL_MAX_CHARS)}…` : s);

/** Plain-text recap for a voice model that didn't hear these turns itself (Realtime after B turns). */
export function formatHistoryRecap(turns: ChatTurn[]): string {
  if (!turns.length) return "";
  const lines = turns.map((t) => `User: ${t.user || "(inaudible)"}\nAssistant: ${t.assistant || "(no reply)"}`);
  return `Earlier in this conversation (handled by another voice pipeline, so you didn't hear it):\n${lines.join("\n")}`;
}
