// Element threads in a pipeline turn (docs/PLAN-threads.md, "Server"): which element the turn is about, what the
// router is told about the threads, and where its decision sends the turn (a new thread, an existing one, a tell,
// or the central conversation).
import { anchorTitle, inferAnchor, matchAnchor, type AnchorInput } from "../../shared/anchor.ts";
import type { RunConfig } from "../../shared/config.ts";
import { normalizePageUrl, type ThreadAnchor } from "../../shared/threads.ts";
import type { RouteDecision, ThreadBrief } from "../adapters/types.ts";
import type { OrchestratorDeps, TurnContext } from "../orchestrators/types.ts";
import { threadStore, type ThreadStore } from "./store.ts";

export interface TurnThreads {
  anchor: ThreadAnchor | null;
  /** anchorTitle(anchor): "the red button". */
  anchorLabel?: string;
  briefs: ThreadBrief[];
  /** The thread whose panel is open: the turn's focus. Typed, dictated or spoken, the turn stays here. */
  pinned?: string;
  /** The turn named a panel's thread that no longer exists: it goes nowhere (never re-routed by the cursor). */
  pinnedMissing?: boolean;
  /**
   * A marker belongs on the anchor: a typed comment, or a click during a spoken turn that was not sent to a
   * different thread.
   */
  clicked?: boolean;
  /** Typed in, with no speech. The marker stays on the click (or the open panel). It does not follow a named thread. */
  typed?: boolean;
  /** From the main message box: can refer to existing threads, with no pointer anchor for a new one. */
  chat?: boolean;
}

/** Where a turn went: a thread (new or existing, or a tell about it). Null = the central conversation. */
export interface ThreadPlan {
  threadId: string;
  relation: "new" | "followup" | "correction" | "tell";
}

/** Threads mode needs chat memory, the thread adapters and a connection channel. */
export function threadsEnabled(cfg: RunConfig, deps: OrchestratorDeps, ctx: TurnContext): boolean {
  return !!(cfg.threads && cfg.memory && deps.openThread && deps.solveInThread && ctx.channel);
}

const safe = <T>(f: () => T, fallback: T): T => {
  try { return f(); } catch (e) { console.warn("[threads] anchor", e); return fallback; }
};

/**
 * The turn's anchor, its match among the threads and the router's briefs. A turn with a panel open (its focus) is
 * told only about that thread: it stays there whatever is said.
 */
export function prepareThreads(
  input: AnchorInput, store: ThreadStore = threadStore(), pinned?: string, flags: { clicked?: boolean; typed?: boolean; chat?: boolean } = {},
): TurnThreads {
  if (flags.chat) {
    const briefs: ThreadBrief[] = store.list().map((t) => ({
      threadId: t.threadId, title: t.title, state: t.state, summary: t.summary,
      onCurrentPage: !!input.pageUrl && t.pageUrl === normalizePageUrl(input.pageUrl), underCursor: false,
    }));
    return { anchor: null, briefs, chat: true };
  }
  const pin = pinned ? store.info(pinned) : undefined;
  if (pinned && !pin) return { anchor: null, briefs: [], pinnedMissing: true };
  if (pin) {
    return {
      anchor: pin.anchor, anchorLabel: pin.title, pinned: pin.threadId, ...(flags.typed ? { typed: true } : {}),
      briefs: [{ threadId: pin.threadId, title: pin.title, state: pin.state, summary: pin.summary, onCurrentPage: true, underCursor: true }],
    };
  }
  const anchor = safe(() => inferAnchor(input), null);
  const threads = store.list();
  const under = anchor ? safe(() => matchAnchor(anchor, threads), null) : null;
  const anchorLabel = (anchor ? safe(() => anchorTitle(anchor), "") : "") || undefined;
  const page = input.pageUrl ? normalizePageUrl(input.pageUrl) : null;
  const briefs: ThreadBrief[] = threads.map((t) => ({
    threadId: t.threadId, title: t.title, state: t.state, summary: t.summary,
    onCurrentPage: page !== null && t.pageUrl === page, underCursor: t.threadId === under,
  }));
  return {
    anchor, anchorLabel, briefs,
    ...(flags.clicked && anchor ? { clicked: true } : {}),
    ...(flags.typed ? { typed: true } : {}),
  };
}

/** The thread the router named, when that thread still exists. */
function namedThread(d: RouteDecision, store: ThreadStore): ThreadPlan | null {
  if (d.tell && store.info(d.tell)) return { threadId: d.tell, relation: "tell" };
  const t = d.target;
  if (t?.kind === "thread" && store.info(t.threadId)) return { threadId: t.threadId, relation: t.relation };
  return null;
}

/** Keep panel replies and element comments anchored. For voice and main chat, follow the router's subject. */
export function planThread(d: RouteDecision, tt: TurnThreads, store: ThreadStore = threadStore()): ThreadPlan | null {
  if (tt.pinnedMissing) return null;
  const delegated = d.intent === "question" || d.intent === "task" ? d.intent : null;
  const t = d.target;
  if (tt.pinned && store.info(tt.pinned)) {
    if (d.tell === tt.pinned) return { threadId: tt.pinned, relation: "tell" };
    return { threadId: tt.pinned, relation: t?.kind === "thread" && t.threadId === tt.pinned ? t.relation : "followup" };
  }
  if (!tt.typed) {
    const named = namedThread(d, store);
    if (named) return named;
  }
  if (tt.anchor && (tt.clicked || tt.typed || t?.kind === "new")) {
    // Recheck the store: another turn may have created this element's thread while the router was working.
    const matched = matchAnchor(tt.anchor, store.list());
    if (matched) {
      if (d.tell === matched) return { threadId: matched, relation: "tell" };
      const relation = t?.kind === "thread" && t.threadId === matched ? t.relation : "followup";
      return { threadId: matched, relation };
    }
    if (delegated || t?.kind === "new") {
      const info = store.create(tt.anchor, tt.anchorLabel ?? "this element", delegated ?? "question");
      return { threadId: info.threadId, relation: "new" };
    }
  }
  return null;
}
