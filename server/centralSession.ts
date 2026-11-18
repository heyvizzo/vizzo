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
import { randomUUID } from "node:crypto";
import type { HarnessThread, OpenHarnessThread, SolveInThread, SolveInThreadOpts } from "./adapters/types.ts";
import { conversationText, getConversation, onConversationReset, type ChatTurn } from "./conversation.ts";
import { harnessSessionInfo } from "./adapters/sessionInfo.ts";
import { threadStore } from "./threads/store.ts";
import { projectDir } from "./project.ts";
import { writerRegistry, type WriterExecution } from "./changes/writers.ts";

const HISTORY_HEADING = "Conversation so far (oldest first):";
const NOTES_HEADING = "Since your last reply in this conversation (oldest first):";

interface Central {
  handle: HarnessThread;
  choice: LlmChoice;
  folder: string | null;
  /** What opened it (a different one, as tests swap in, gets a session of its own). */
  opener: OpenHarnessThread;
  /** The conversation's turns (by turnId) the session knows: it answered them, or was told them. */
  seen: Set<string>;
  running: number;
}

let central: Central | null = null;
// Keep lightweight handles after their processes are released, so completed work can be continued.
const sessions = new Map<HarnessThread, Central>();

onConversationReset(() => {
  const handles = [...sessions.keys()];
  sessions.clear();
  central = null;
  for (const handle of handles) try { handle.close(); } catch { /* already gone */ }
  publishSession();
});

let publishedSession = "";
function publishSession(): void {
  const session = harnessSessionInfo(central?.handle ?? null);
  const key = JSON.stringify(session);
  if (key === publishedSession) return;
  publishedSession = key;
  threadStore().broadcast({ type: "conversation.session", session });
}

function open(openThread: OpenHarnessThread, choice: LlmChoice, forkOf?: Central, history?: readonly ChatTurn[]): Central {
  const seen = new Set(forkOf?.seen);
  let firstHistory = history;
  let replayed: readonly ChatTurn[] = [];
  // Told as they go out: a request that then fails may have left them in the session or not; one that is replayed
  // gets them all again anyway.
  const tell = (turns: ChatTurn[], heading: string): string => {
    firstHistory = undefined;
    for (const t of turns) seen.add(t.turnId);
    return conversationText(turns, heading);
  };
  const folder = forkOf ? forkOf.folder : projectDir();
  const handle = openThread({
    role: "solver", choice, projectFolder: folder,
    ...(forkOf ? { forkOf: forkOf.handle } : {}),
    onSession: publishSession,
    replay: () => {
      replayed = [...(firstHistory ?? getConversation())];
      return tell([...replayed], HISTORY_HEADING);
    },
    replayAnnotations: () => replayed.flatMap((t) => (t.annotation ? [t.annotation] : [])).slice(-4),
    notes: () => tell((firstHistory ?? getConversation()).filter((t) => !seen.has(t.turnId)), NOTES_HEADING),
  });
  const c = { handle, choice, folder, seen, opener: openThread, running: 0 };
  sessions.set(handle, c);
  return c;
}

/** The conversation's session, if one is open (its harness and model are the ones it was opened with). */
export function centralSession(): HarnessThread | null {
  return central?.handle ?? null;
}

/** All native sessions owned by this conversation, including completed background tasks. */
export function conversationSessions(): HarnessThread[] { return [...sessions.keys()]; }

/** Choose a completed task's native context for the next main-conversation request. */
export function continueConversationSession(sessionId: string, context?: string): void {
  const c = [...sessions.values()].find((s) => s.handle.session?.()?.id === sessionId);
  if (!c) throw new Error("This session is no longer available in Vizzo.");
  if (c.running || central?.running) throw new Error("Wait for the current answer to finish before switching sessions.");
  central = c;
  if (context?.trim()) getConversation().push({
    turnId: `resume:${randomUUID()}`, approach: "pipeline",
    user: `(Continuing an earlier task: ${context.trim()})`,
    assistant: "The next message is a follow-up to this task, in its saved session.", detail: "",
  });
  publishSession();
}

/** End a job's native connection while retaining its handle and pinned settings for later continuation. */
export async function finishJobSession(handle: HarnessThread): Promise<void> {
  const c = sessions.get(handle);
  if (!c) { handle.close(); return; } // A conversation reset already forgot it.
  c.running = 0;
  if (!handle.session?.() || !handle.release) {
    sessions.delete(handle);
    handle.close();
    return;
  }
  try { await handle.release(); }
  catch (e) { console.warn("[session] couldn't release completed task", e); }
}

/** The running request now belongs to a background job. Future turns use a separate continuation. */
export function backgroundCentralSession(handle: HarnessThread): void {
  if (central?.handle !== handle) return;
  central = open(central.opener, handle.choice ?? central.choice, central);
  publishSession();
}

/**
 * One delegated turn of the conversation, on its session (opened now, with `choice`, if there is none). Requests
 * run one after another.
 */
export async function solveCentral(
  deps: { openThread: OpenHarnessThread; solveInThread: SolveInThread }, choice: LlmChoice, turnId: string,
  opts: Omit<SolveInThreadOpts, "thread" | "kind" | "execution">, onExecution?: (execution: WriterExecution) => void,
): Promise<Awaited<ReturnType<SolveInThread>>> {
  if (central && central.opener !== deps.openThread) {
    try { central.handle.close(); } catch { /* gone */ }
    sessions.delete(central.handle);
    central = null;
  }
  const c = (central ??= open(deps.openThread, choice));
  publishSession();
  // The turn joins the conversation's log when it ends: the session has it already.
  c.seen.add(turnId);
  c.running++;
  const execution = writerRegistry().queue({
    writer: { kind: "central", id: turnId }, title: opts.question, request: opts.original ?? opts.question,
    folder: c.folder, harness: (c.handle.choice ?? c.choice).provider, purpose: "request",
  });
  onExecution?.(execution);
  try {
    return await execution.run(() => deps.solveInThread({ ...opts, thread: c.handle, execution, kind: "request" }));
  } catch (e) {
    c.seen.delete(turnId);
    throw e;
  } finally {
    c.running--;
    publishSession();
  }
}

/**
 * A session for one long task: a fork of the conversation's when it has a saved one (same harness, model and
 * prompt), told what the conversation's session hasn't heard yet; otherwise a new one with `choice`, told the
 * history. The caller releases it through `finishJobSession` when the task is over.
 */
export function openJobSession(openThread: OpenHarnessThread, choice: LlmChoice, history: readonly ChatTurn[]): HarnessThread {
  const c = central?.opener === openThread ? central : null;
  const job = open(openThread, c?.handle.choice ?? choice, c ?? undefined, history);
  job.running = 1;
  return job.handle;
}
