// The central conversation's harness session (docs/ARCHITECTURE.md "Harness sessions"). The solver's work in the
// page-wide conversation runs on one session of its harness, so it keeps its own context from turn to turn (what it
// read, what it changed), like a thread does for one element. It is opened by the first delegated turn with the
// smart tier as chosen then, and keeps that harness, model and prompt until "New conversation" closes it (the
// harness's saved session stays on disk; Vizzo no longer continues it).
//
// The session only sees the turns that were delegated to it. Everything else the conversation records (what the
// router answered itself, threads starting and finishing, background jobs' results) reaches it as notes with its
// next request: the turns it hasn't been told. A session without the history (the harness's saved one couldn't be
// continued) is told all of it instead.
//
// A long task runs on a session of its own, forked from this one where the harness can (`openJobSession`), so the
// conversation stays free while it works. Its result joins the conversation, and reaches this session as a note.
import type { LlmChoice } from "../shared/config.ts";
import type { HarnessThread, OpenHarnessThread, SolveInThread, SolveInThreadOpts } from "./adapters/types.ts";
import { conversationText, getConversation, onConversationReset, type ChatTurn } from "./conversation.ts";

const HISTORY_HEADING = "Conversation so far (oldest first):";
const NOTES_HEADING = "Since your last reply in this conversation (oldest first):";

interface Central {
  handle: HarnessThread;
  /** What opened it (a different one, as tests swap in, gets a session of its own). */
  opener: OpenHarnessThread;
  /** The conversation's turns (by turnId) the session knows: it answered them, or was told them. */
  seen: Set<string>;
}

let central: Central | null = null;

onConversationReset(() => {
  const c = central;
  central = null;
  try { c?.handle.close(); } catch { /* already gone */ }
});

const unseen = (seen: ReadonlySet<string>): ChatTurn[] => getConversation().filter((t) => !seen.has(t.turnId));

function open(openThread: OpenHarnessThread, choice: LlmChoice): Central {
  const seen = new Set<string>();
  // Told as they go out: a request that then fails may have left them in the session or not; one that is replayed
  // gets them all again anyway.
  const tell = (turns: ChatTurn[], heading: string): string => {
    for (const t of turns) seen.add(t.turnId);
    return conversationText(turns, heading);
  };
  const handle = openThread({
    role: "solver", choice,
    replay: () => tell([...getConversation()], HISTORY_HEADING),
    replayAnnotations: () => getConversation().flatMap((t) => (t.annotation ? [t.annotation] : [])).slice(-4),
    notes: () => tell(unseen(seen), NOTES_HEADING),
  });
  return { handle, seen, opener: openThread };
}

/** The conversation's session, if one is open (its harness and model are the ones it was opened with). */
export function centralSession(): HarnessThread | null {
  return central?.handle ?? null;
}

/**
 * One delegated turn of the conversation, on its session (opened now, with `choice`, if there is none). Requests
 * run one after another.
 */
export async function solveCentral(
  deps: { openThread: OpenHarnessThread; solveInThread: SolveInThread }, choice: LlmChoice, turnId: string,
  opts: Omit<SolveInThreadOpts, "thread" | "kind">,
): Promise<Awaited<ReturnType<SolveInThread>>> {
  if (central && central.opener !== deps.openThread) { try { central.handle.close(); } catch { /* gone */ } central = null; }
  const c = (central ??= open(deps.openThread, choice));
  // The turn joins the conversation's log when it ends: the session has it already.
  c.seen.add(turnId);
  try {
    return await deps.solveInThread({ ...opts, thread: c.handle, kind: "request" });
  } catch (e) {
    c.seen.delete(turnId);
    throw e;
  }
}

/**
 * A session for one long task: a fork of the conversation's when it has a saved one (same harness, model and
 * prompt), told what the conversation's session hasn't heard yet; otherwise a new one with `choice`, told the
 * history. The caller closes it when the task is over.
 */
export function openJobSession(openThread: OpenHarnessThread, choice: LlmChoice, history: readonly ChatTurn[]): HarnessThread {
  const c = central?.opener === openThread ? central : null;
  const told = c ? new Set(c.seen) : new Set<string>();
  return openThread({
    role: "solver", choice: c?.handle.choice ?? choice,
    ...(c ? { forkOf: c.handle } : {}),
    replay: () => conversationText(history, HISTORY_HEADING),
    replayAnnotations: () => history.flatMap((t) => (t.annotation ? [t.annotation] : [])).slice(-4),
    notes: () => conversationText(history.filter((t) => !told.has(t.turnId)), NOTES_HEADING),
  });
}
