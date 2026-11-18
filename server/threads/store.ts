import { drawingContext } from "../adapters/drawing.ts";
// Element threads: the process-level store (docs/PLAN-threads.md, "Lifetime"). Every thread's record, its harness
// session handle and its run queue, plus the central conversation (server/conversation.ts). Survives page and
// sidebar reloads; with persistTo() (the app and `npm run dev:server`, not tests) the threads are also saved to disk
// and restored at the next start (server/threads/persist.ts). Every change goes out to every connected Session
// (`thread`, `thread.removed`); a Session gets `threads.snapshot` when it connects.
import { randomUUID } from "node:crypto";
import { projectDir } from "../project.ts";
import type { Intent, ServerMsg } from "../../shared/protocol.ts";
import type { ThreadAnchor, ThreadInfo, ThreadMessage } from "../../shared/threads.ts";
import type { HarnessThread } from "../adapters/types.ts";
import { getConversation, resetConversation, type ChatTurn } from "../conversation.ts";
import type { Floor } from "./floor.ts";
import type { RunWindow } from "./runner.ts";
import { focusedThreadId } from "./policy.ts";
import { loadThreads, writeThreads, type SavedThread, type ThreadResume } from "./persist.ts";

/** Changes are written this long after the last one (a streamed run changes its thread often). */
const SAVE_DELAY_MS = 400;

export const INTERRUPTED_TEXT = "Vizzo was closed before this finished. What it already changed stays. Resume picks up where it left off.";

/** What the runner keeps per thread (server/threads/runner.ts). */
export interface ThreadRunState {
  /** Stop the current run and drop the queue; close the harness session. */
  stop(): void;
  stopForDeletion?(): Promise<void>;
  readonly working?: boolean;
}

export interface ThreadRecord {
  info: ThreadInfo;
  handle: HarnessThread | null;
  run: ThreadRunState | null;
  projectFolder?: string | null;
  /** Restored from disk: what its harness session is reopened with (until a handle is opened). */
  resume?: ThreadResume;
  activeRequest?: SavedThread["activeRequest"];
}

/** A connected Session. */
export interface ThreadSubscriber {
  send(msg: ServerMsg): void;
  floor: Floor;
  prepareReset?(): void;
}

export class ThreadStore {
  private records = new Map<string, ThreadRecord>();
  private subs: ThreadSubscriber[] = [];
  /** Injected clock (tests). */
  now: () => number = Date.now;
  /** Every run's time window and edited files (reconcile, server/threads/runner.ts). */
  readonly runLog: RunWindow[] = [];
  private file: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private deleting: Set<string> | null = null;
  private handedOff = new Set<string>();
  private resetting = false;
  private closing = false;
  private ledgerAvailable = true;

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

  get turnsBlocked(): boolean { return this.resetting || this.closing; }
  get sourceControlAvailable(): boolean { return this.ledgerAvailable; }
  disableSourceControl(): void { this.ledgerAvailable = false; }
  blocksRun(threadId: string): boolean { return this.closing || this.deleting?.has(threadId) === true || this.handedOff.has(threadId); }

  beginDeletion(threadIds: readonly string[], reset: boolean): () => void {
    if (this.closing) throw new Error("Vizzo is closing.");
    if (this.deleting) throw new Error("Another thread deletion is still in progress.");
    this.deleting = new Set(threadIds);
    this.resetting = reset;
    return () => { this.deleting = null; this.resetting = false; };
  }

  beginShutdown(): void { this.closing = true; }

  prepareReset(): void {
    for (const sub of [...this.subs]) sub.prepareReset?.();
  }

  clearConversation(): void {
    for (const f of this.floors()) f.clear();
    resetConversation();
    this.broadcast({ type: "threads.snapshot", threads: this.list() });
  }

  create(anchor: ThreadAnchor, title: string, intent: Intent): ThreadInfo {
    const now = this.now();
    const info: ThreadInfo = {
      threadId: randomUUID(), pageUrl: anchor.pageUrl, anchor, title, state: "idle", intent, summary: "",
      unread: false, awaitingReply: false, messages: [], createdAt: now, lastInteractionAt: now,
    };
    this.records.set(info.threadId, { info, handle: null, run: null, projectFolder: projectDir() });
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
    return this.update(threadId, (t) => { t.messages.push(msg);
      // Keep the latest 8 full images per thread. Older requests retain their geometry and element context.
      const attachments = t.messages.filter(m => m.annotation);
      for (const old of attachments.slice(0, -8)) {
        old.text += `\n\n[Drawing preview expired from retained history]\n${drawingContext(old.annotation!)}`;
        delete old.annotation;
      }
      fn?.(t); }) ? msg : undefined;
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
    this.scheduleSave();
    return true;
  }

  /** Called after the source-control ledger has accepted the threads and their changes. */
  removeDurably(threadIds: readonly string[]): void {
    if (!threadIds.length) return;
    const removing = new Set(threadIds);
    for (const id of threadIds) this.handedOff.add(id);
    if (this.file) writeThreads(this.file, [...this.records.values()].filter(({ info }) => !removing.has(info.threadId)).map(savedOf), true);
    for (const id of threadIds) {
      this.remove(id);
      this.handedOff.delete(id);
    }
  }

  /** Stop writes without closing the native session before the ledger handoff. */
  async stopForDeletion(threadId: string): Promise<void> {
    await this.records.get(threadId)?.run?.stopForDeletion?.();
  }

  /** "New conversation": every thread (runs stopped) and the central conversation. */
  reset(): void {
    const all = [...this.records.values()];
    this.records.clear();
    for (const r of all) stopRecord(r);
    this.clearConversation();
    this.scheduleSave();
  }

  /**
   * Save the threads to `file` from now on, after restoring the ones saved there. A thread that was working when the
   * app closed comes back interrupted (its run is gone; its harness kept the session up to that point).
   */
  persistTo(file: string, pendingRemovals: readonly string[] = []): void {
    const pending = new Set(pendingRemovals);
    const savedThreads = loadThreads(file, pending.size > 0).filter(({ info }) => !pending.has(info.threadId));
    // Finish the threads.json side of a previous handoff before any saved native session can be reopened.
    if (pending.size) writeThreads(file, savedThreads, true);
    this.file = file;
    for (const saved of savedThreads) {
      if (this.records.has(saved.info.threadId)) continue;
      const info = restoredInfo(saved, this.now());
      const projectFolder = saved.projectFolder !== undefined ? saved.projectFolder : saved.resume?.spec.project ?? null;
      this.records.set(info.threadId, {
        info, handle: null, run: null, projectFolder, resume: saved.resume,
        ...(info.interrupted && saved.activeRequest ? { activeRequest: saved.activeRequest } : {}),
      });
    }
    if (this.records.size) console.log(`[threads] restored ${this.records.size} thread${this.records.size === 1 ? "" : "s"} from ${file}`);
    this.broadcast({ type: "threads.snapshot", threads: this.list() });
    if (!pending.size) this.flush();
  }

  /** Write any pending change now (at exit). */
  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (!this.file) return;
    try { writeThreads(this.file, [...this.records.values()].map(savedOf)); }
    catch (e) { console.warn("[threads] save failed", e); }
  }

  private scheduleSave(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  private emit(threadId: string): void {
    const r = this.records.get(threadId);
    if (r) this.broadcast({ type: "thread", thread: snapshot(r.info) });
    this.scheduleSave();
  }
}

/** What goes to disk: the record, and how to reopen its session (from the live handle, else what it was restored with). */
function savedOf(r: ThreadRecord): SavedThread {
  const h = r.handle;
  const resume: ThreadResume | undefined = h?.spec && h.choice
    ? { choice: h.choice, spec: h.spec, ...(h.session?.() ? { ref: h.session!()! } : {}) }
    : r.resume;
  return { info: r.info, projectFolder: r.projectFolder, resume, activeRequest: r.activeRequest };
}

/** A saved thread as it comes back: nothing is running any more. */
function restoredInfo(saved: SavedThread, now: number): ThreadInfo {
  const info = saved.info;
  if (info.state !== "running") return info;
  return {
    ...info, state: "idle", interrupted: true, awaitingReply: false,
    messages: [...info.messages, { id: randomUUID(), turnId: null, at: now, role: "system", kind: "interrupted", text: INTERRUPTED_TEXT }],
  };
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
