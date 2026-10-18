// Element threads: the process-level store (docs/PLAN-threads.md, "Lifetime"). Every thread's record, its harness
// session handle and its run queue, plus the central conversation (server/conversation.ts). Lives as long as the
// server process: survives page and sidebar reloads, gone when the app closes. Every change goes out to every
// connected Session (`thread`, `thread.removed`); a Session gets `threads.snapshot` when it connects.
import { randomUUID } from "node:crypto";
import type { Intent, ServerMsg } from "../../shared/protocol.ts";
import type { ThreadAnchor, ThreadInfo, ThreadMessage } from "../../shared/threads.ts";
import type { HarnessThread } from "../adapters/types.ts";
import { getConversation, resetConversation, type ChatTurn } from "../conversation.ts";
import type { Floor } from "./floor.ts";
import type { RunWindow } from "./runner.ts";
import { focusedThreadId } from "./policy.ts";

/** What the runner keeps per thread (server/threads/runner.ts). */
export interface ThreadRunState {
  /** Stop the current run and drop the queue; close the harness session. */
  stop(): void;
}

export interface ThreadRecord {
  info: ThreadInfo;
  handle: HarnessThread | null;
  run: ThreadRunState | null;
}

/** A connected Session. */
export interface ThreadSubscriber {
  send(msg: ServerMsg): void;
  floor: Floor;
}

export class ThreadStore {
  private records = new Map<string, ThreadRecord>();
  private subs: ThreadSubscriber[] = [];
  /** Injected clock (tests). */
  now: () => number = Date.now;
  /** Every run's time window and edited files (reconcile, server/threads/runner.ts). */
  readonly runLog: RunWindow[] = [];

  get conversation(): ChatTurn[] { return getConversation(); }

  /** Register a Session: it gets the snapshot right away. Returns the unsubscribe. */
  subscribe(sub: ThreadSubscriber): () => void {
    this.subs.push(sub);
    sub.send({ type: "threads.snapshot", threads: this.list() });
    return () => { this.subs = this.subs.filter((s) => s !== sub); };
  }

  /** The Session that last started a turn (or connected): it speaks thread lines. */
  touch(sub: ThreadSubscriber): void {
    const i = this.subs.indexOf(sub);
    if (i >= 0) { this.subs.splice(i, 1); this.subs.push(sub); }
  }

  speaker(): Floor | null { return this.subs.at(-1)?.floor ?? null; }
  floors(): Floor[] { return this.subs.map((s) => s.floor); }

  /** Some page is connected. */
  connected(): boolean { return this.subs.length > 0; }

  broadcast(msg: ServerMsg): void {
    for (const s of [...this.subs]) s.send(msg);
  }

  list(): ThreadInfo[] { return [...this.records.values()].map((r) => snapshot(r.info)); }
  get(threadId: string): ThreadRecord | undefined { return this.records.get(threadId); }
  info(threadId: string): ThreadInfo | undefined { return this.records.get(threadId)?.info; }
  focused(): string | null { return focusedThreadId([...this.records.values()].map((r) => r.info)); }

  create(anchor: ThreadAnchor, title: string, intent: Intent): ThreadInfo {
    const now = this.now();
    const info: ThreadInfo = {
      threadId: randomUUID(), pageUrl: anchor.pageUrl, anchor, title, state: "idle", intent, summary: "",
      unread: false, awaitingReply: false, messages: [], createdAt: now, lastInteractionAt: now,
    };
    this.records.set(info.threadId, { info, handle: null, run: null });
    this.emit(info.threadId);
    return info;
  }

  /** Change a thread and broadcast it. No-op for a removed thread. */
  update(threadId: string, fn: (t: ThreadInfo) => void): ThreadInfo | undefined {
    const r = this.records.get(threadId);
    if (!r) return undefined;
    fn(r.info);
    this.emit(threadId);
    return r.info;
  }

  addMessage(threadId: string, m: Omit<ThreadMessage, "id" | "at"> & { at?: number }, fn?: (t: ThreadInfo) => void): ThreadMessage | undefined {
    const msg: ThreadMessage = { id: randomUUID(), at: this.now(), ...m };
    return this.update(threadId, (t) => { t.messages.push(msg); fn?.(t); }) ? msg : undefined;
  }

  /** created / followup / correction / tell / focus. */
  bump(threadId: string): void {
    this.update(threadId, (t) => { t.lastInteractionAt = Math.max(this.now(), t.lastInteractionAt + 1); });
  }

  /** The thread's result counts as told: read, nothing pending, no question open. */
  markTold(threadId: string): void {
    this.update(threadId, (t) => {
      t.unread = false;
      t.awaitingReply = false;
      if (t.state === "pending") t.state = "idle";
    });
  }

  /** The user opened the thread's panel. */
  focus(threadId: string): void {
    if (!this.records.has(threadId)) return;
    this.bump(threadId);
    this.markTold(threadId);
    for (const f of this.floors()) f.drop(threadId);
  }

  /** Delete: stop the run, close the session, forget it. The central conversation keeps its lines. */
  remove(threadId: string): boolean {
    const r = this.records.get(threadId);
    if (!r) return false;
    this.records.delete(threadId);
    stopRecord(r);
    for (const f of this.floors()) f.drop(threadId);
    this.broadcast({ type: "thread.removed", threadId });
    return true;
  }

  /** "New conversation": every thread (runs stopped) and the central conversation. */
  reset(): void {
    const all = [...this.records.values()];
    this.records.clear();
    for (const r of all) stopRecord(r);
    for (const f of this.floors()) f.clear();
    resetConversation();
    this.broadcast({ type: "threads.snapshot", threads: [] });
  }

  private emit(threadId: string): void {
    const r = this.records.get(threadId);
    if (r) this.broadcast({ type: "thread", thread: snapshot(r.info) });
  }
}

function stopRecord(r: ThreadRecord): void {
  try { r.run?.stop(); } catch (e) { console.warn("[threads] stop failed", e); }
  if (!r.run) try { r.handle?.close(); } catch { /* ignore */ }
}

/** A copy safe to send (later changes don't leak into an already-sent message). */
function snapshot(t: ThreadInfo): ThreadInfo {
  return { ...t, messages: t.messages.map((m) => ({ ...m })), ...(t.costItems ? { costItems: [...t.costItems] } : {}) };
}

let store = new ThreadStore();

export function threadStore(): ThreadStore { return store; }

/** Tests: a fresh store (stops every run) and an empty central conversation. */
export function resetThreadStore(): ThreadStore {
  store.reset();
  store = new ThreadStore();
  return store;
}
