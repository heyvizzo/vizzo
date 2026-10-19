// Element threads (docs/PLAN-threads.md): feedback is scoped to the page element it's about. Each element gets a
// thread that runs in its own persistent harness session; markers on the page show each thread's state.
// This file is the contract shared by the server (server/threads/), the chat sidebar and the page overlay.
import type { CostItem, Intent } from "./protocol.ts";

/**
 * running: the harness is working on it (subtle spinning marker).
 * pending: finished, but only a reminder was spoken; the result waits for the user (drawn like idle: the task is done, only unread).
 * idle: nothing to do, nothing unread (solid marker). failed: the last run failed (red marker).
 * queued: client-only, feedback recorded with Instant off and not sent yet (web/chat/queue.ts; teal marker).
 */
export type ThreadState = "running" | "pending" | "idle" | "failed" | "queued";

/** The element a thread is about, as seen when the thread was created (re-resolved on the page by the overlay). */
export interface ThreadAnchor {
  /** normalizePageUrl() of the page the element is on. */
  pageUrl: string;
  /** Short selector (ElementDetails.selector). */
  selector: string;
  /** Full path from body (ElementDetails.domPath / CursorSample.elementPath). */
  domPath: string;
  /** Closest [data-source] "file:line", if any. */
  dataSource: string | null;
  /** The element's own label (CursorSample.label). */
  label: string | null;
  /** Visible text, capped. */
  text: string | null;
  /** ARIA role attribute, if any. */
  role: string | null;
  tag: string;
  /** Document coordinates (viewport bounds + scroll) when the anchor was taken: the fallback position. */
  bounds: { x: number; y: number; width: number; height: number };
  /** Where the pointer was on the element (document coordinates, same frame as `bounds`): the marker sits there. */
  point?: { x: number; y: number };
}

export type ThreadMessageKind =
  | "request" // the user's first feedback on this element
  | "followup" // more feedback, queued behind the current run
  | "correction" // replaces the current run's request (the run is restarted)
  | "ack" // what the voice layer said right away
  | "result" // the harness's answer (spoken line in `text`, full answer in `detail`)
  | "reminder" // "An earlier task on … finished"
  | "reconcile" // system follow-up after another thread changed the same file
  | "stopped" // the user stopped the run before it finished
  | "error";

export interface ThreadMessage {
  id: string;
  /** The turn that produced it (null for system messages such as reminders and reconcile follow-ups). */
  turnId: string | null;
  /** Epoch ms. */
  at: number;
  role: "user" | "assistant" | "system";
  kind: ThreadMessageKind;
  text: string;
  /** Full harness answer (results only). */
  detail?: string;
  /** Project-relative files the run edited (results only). */
  filesTouched?: string[];
}

export interface ThreadInfo {
  threadId: string;
  pageUrl: string;
  anchor: ThreadAnchor;
  /** Short spoken/visible name of the element: "the red button", "the footer links". */
  title: string;
  state: ThreadState;
  /** The latest intent routed to it. */
  intent: Intent;
  /** One line about what the thread did, for the router, the central conversation and the sidebar list. */
  summary: string;
  /** A finished result hasn't been told in full yet. */
  unread: boolean;
  /** The thread's last spoken line asked the user something (a reminder or a question): its bubble stays up. */
  awaitingReply: boolean;
  messages: ThreadMessage[];
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms: created, a follow-up/correction routed to it, its result told, or its panel opened. */
  lastInteractionAt: number;
  costUsd?: number;
  costItems?: CostItem[];
}

/**
 * One spoken line from a thread (threadId) or from the central conversation (threadId null), outside a turn.
 * Shown as a bubble from the thread's marker (the sidebar for central lines and threads on other pages).
 * Framed: state "start" right before its audio, "end" after it (audio segment "notice").
 */
export interface ThreadSay {
  sayId: string;
  threadId: string | null;
  text: string;
  /** A reminder or a question back to the user (the bubble is drawn as one). */
  needsReply: boolean;
}

/** At most this many threads keep a live harness session; the least recently used idle one is closed (replayed when needed). */
export const MAX_LIVE_THREAD_SESSIONS = 10;

/** A thread's title shown on its own ("The red button"); titles are kept lowercase for use mid-sentence. */
export function displayTitle(title: string): string {
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/**
 * The page identity threads are scoped to: the full URL without its #fragment. `pricing.html#faq` and `pricing.html`
 * are the same page; `pricing.html?plan=pro` is a different one.
 */
export function normalizePageUrl(url: string): string {
  const i = url.indexOf("#");
  return i < 0 ? url : url.slice(0, i);
}
