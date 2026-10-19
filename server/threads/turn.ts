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
  /** The thread whose panel is open: every turn goes to it. */
  pinned?: string;
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
 * The turn's anchor, its match among the threads and the router's briefs. `pinned` (its panel is open): the router
 * is told only about that thread, as the pointed one, and planThread sends the turn there.
 */
export function prepareThreads(input: AnchorInput, store: ThreadStore = threadStore(), pinned?: string): TurnThreads {
  const pin = pinned ? store.info(pinned) : undefined;
  if (pin) {
    return {
      anchor: pin.anchor, anchorLabel: pin.title, pinned: pin.threadId,
      briefs: [{ threadId: pin.threadId, title: pin.title, state: pin.state, summary: pin.summary, onCurrentPage: true, underCursor: true }],
    };
  }
  const anchor = safe(() => inferAnchor(input), null);
  const threads = store.list();
  const under = anchor ? safe(() => matchAnchor(anchor, threads), null) : null;
  const anchorLabel = anchor ? safe(() => anchorTitle(anchor), "") || undefined : undefined;
  const page = input.pageUrl ? normalizePageUrl(input.pageUrl) : null;
  const briefs: ThreadBrief[] = threads.map((t) => ({
    threadId: t.threadId, title: t.title, state: t.state, summary: t.summary,
    onCurrentPage: page !== null && t.pageUrl === page, underCursor: t.threadId === under,
  }));
  return { anchor, anchorLabel, briefs };
}

/**
 * Act on the router's target: a tell or an existing thread as given; `new` creates the thread (only for delegated
 * work on a pointed element; anything else goes to the central conversation).
 */
export function planThread(d: RouteDecision, tt: TurnThreads, store: ThreadStore = threadStore()): ThreadPlan | null {
  if (tt.pinned && store.info(tt.pinned)) {
    const t = d.target;
    if (d.tell === tt.pinned) return { threadId: tt.pinned, relation: "tell" };
    return { threadId: tt.pinned, relation: t?.kind === "thread" && t.threadId === tt.pinned ? t.relation : "followup" };
  }
  if (d.tell && store.info(d.tell)) return { threadId: d.tell, relation: "tell" };
  const t = d.target;
  if (t?.kind === "thread" && store.info(t.threadId)) return { threadId: t.threadId, relation: t.relation };
  if (t?.kind === "new" && tt.anchor && (d.intent === "question" || d.intent === "task")) {
    const info = store.create(tt.anchor, tt.anchorLabel ?? "this element", d.intent);
    return { threadId: info.threadId, relation: "new" };
  }
  return null;
}
