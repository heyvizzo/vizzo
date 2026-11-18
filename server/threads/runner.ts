import { writerRegistry, type WriterExecution } from "../changes/writers.ts";
import { projectDir } from "../project.ts";
import { drawingContext } from "../adapters/drawing.ts";
import type { DrawingAnnotation } from "../../shared/annotations.ts";
// Element threads: one run queue per thread (docs/PLAN-threads.md, "Follow-up to a running thread", "Concurrent
// edits to one file"). Each request runs in the thread's own harness session (deps.openThread, opened on first use;
// it resumes its harness's saved session when its process is gone, and replays the thread's history as text only when
// there is none to resume). A follow-up waits behind the current run; a
// correction aborts it and runs the combined request first. When a run finishes, its result joins the thread and
// the central conversation and is announced by the notice policy (in full, or a reminder) on the speaking floor.
//
// Reconcile: every run's time window and edited files are kept. When a run finishes and another thread's run that
// overlapped it in time touched a same file, the later-finishing thread gets ONE system follow-up naming the files.
import { taskTimeoutMs, type RunConfig } from "../../shared/config.ts";
import type { CostItem, Intent, PointingTarget, ServerMsg } from "../../shared/protocol.ts";
import { displayTitle, type ThreadInfo } from "../../shared/threads.ts";
import { beginTask } from "../activity.ts";
import type { Mark } from "../clock.ts";
import { llmCostItem } from "../cost.ts";
import { stripVoiceCues } from "../../shared/cues.ts";
import { useVoiceCues } from "../adapters/voiceCues.ts";
import { spokenFallback } from "../orchestrators/jobs.ts";
import { tracer, type CallTrace } from "../orchestrators/trace.ts";
import type { OrchestratorDeps } from "../orchestrators/types.ts";
import { ttsSpeaker } from "./floor.ts";
import { awayText, failureText, finishedLine, finishMode, reconcileText, reminderText } from "./policy.ts";
import { onBrowserUrl, onPage } from "../browserPage.ts";
import { threadStore, type ThreadRecord, type ThreadRunState, type ThreadStore } from "./store.ts";
import { fitLines } from "../conversation.ts";
import { harnessSessionInfo } from "../adapters/sessionInfo.ts";

const SUMMARY_MAX = 160;
const noMark: Mark = () => {};

/** A full result held for a page the user had left (ThreadRunner.announce): read out when they're back on it. */
interface HeldResult {
  store: ThreadStore;
  spoken: string;
  speaker: ReturnType<typeof ttsSpeaker>;
  language?: string;
  addSpokenCost: (cost: CostItem | null) => void;
}
const heldResults = new Map<string, HeldResult>();

/** Speak a thread's full result on the floor; told once heard, pending otherwise. */
function speakResult(
  store: ThreadStore, id: string, spoken: string, speaker: ReturnType<typeof ttsSpeaker>, language: string | undefined,
  addSpokenCost: (cost: CostItem | null) => void,
): void {
  const info = store.info(id);
  const floor = store.speaker();
  if (!info) return;
  if (!floor) return void store.update(id, (t) => { if (t.state === "idle") t.state = "pending"; });
  floor.enqueue({
    kind: "result", language, speaker,
    say: { sayId: `${id}:${info.messages.length}`, threadId: id, text: spoken, needsReply: false },
    valid: () => store.info(id)?.unread === true,
    onDone: (outcome, cost) => {
      addSpokenCost(cost);
      if (outcome === "spoken") store.markTold(id);
      else store.update(id, (t) => { if (t.state === "idle") t.state = "pending"; });
    },
  });
}

/** The user came to a page: held results for threads on it are read out (those already told, or gone, are dropped). */
onBrowserUrl(() => {
  for (const [id, held] of [...heldResults]) {
    const info = held.store.info(id);
    if (!info || !info.unread || held.store !== threadStore()) { heldResults.delete(id); continue; }
    if (!onPage(info.pageUrl)) continue;
    heldResults.delete(id);
    for (const f of held.store.floors()) f.drop(id); // the "on the pricing page" line, if it hasn't played yet
    speakResult(held.store, id, held.spoken, held.speaker, held.language, held.addSpokenCost);
  }
});

/** direct: typed in the panel of a thread that always uses the smart model (no router: the harness decides question or task). */
export type RunKind = "request" | "followup" | "correction" | "reconcile" | "direct";
type ThreadDeps = Pick<OrchestratorDeps, "openThread" | "solveInThread" | "openTts" | "voiceId">;

export interface RunSpec {
  annotation?: DrawingAnnotation;
  kind: RunKind;
  /** What the harness is asked. */
  question: string;
  /** The user's own words, when `question` is the router's reading of them (SolveTaskOpts.original). */
  original?: string;
  /** The turn that asked (null for system follow-ups). */
  turnId: string | null;
  config: RunConfig;
  intent: Intent;
  pointing?: PointingTarget[];
  pageContext?: string;
  language?: string;
  /** The thread message this run answers (recorded before the run): a replay stops before it. */
  messageId?: string;
  /**
   * Inline run (a short new question answered within its turn): the turn streams and speaks the result itself.
   * If the turn is over by the time the result is in (`active()` false), it's announced like a background run.
   */
  inline?: { mark: Mark; trace: () => CallTrace; onSpokenLine(line: string): void; onDelta(d: string): void; active(): boolean };
}

export interface RunResult { text: string; spoken: string; usage: unknown; filesTouched: string[] }

/** One run's time window, for reconcile. */
export interface RunWindow { threadId: string; start: number; end: number | null; files: string[]; kind: RunKind }

interface Queued { spec: RunSpec; execution: WriterExecution; resolve: (r: RunResult | null) => void; reject: (e: unknown) => void }

class ThreadRunner implements ThreadRunState {
  private queue: Queued[] = [];
  private current: { q: Queued; abortedBy: "correction" | "stop" | "user" | null; failed?: boolean } | null = null;
  private stopped = false;
  /** The current run's own message: the replay stops before it (it's sent as the request itself). */
  private replayCut: string | null = null;

  constructor(private store: ThreadStore, private threadId: string, private rec: ThreadRecord, private deps: ThreadDeps) {}

  get busy(): boolean { return this.current !== null; }
  get pending(): number { return this.queue.length; }

  enqueue(spec: RunSpec, front = false): Promise<RunResult | null> {
    return new Promise((resolve, reject) => {
      const handle = this.rec.handle;
      const folder = handle?.projectFolder !== undefined ? handle.projectFolder : handle?.spec ? handle.spec.project ?? null
        : this.rec.resume ? this.rec.resume.spec.project ?? null
        : this.rec.projectFolder !== undefined ? this.rec.projectFolder : projectDir();
      this.rec.projectFolder = folder;
      const execution = writerRegistry().queue({
        writer: { kind: "thread", id: this.threadId }, title: this.rec.info.title, request: spec.original ?? spec.question,
        folder, purpose: spec.kind, harness: (handle?.choice ?? this.rec.resume?.choice ?? spec.config.llm.smart).provider,
      });
      const q = { spec, execution, resolve, reject };
      if (front) this.queue.unshift(q); else this.queue.push(q);
      if (spec.kind !== "reconcile") this.store.update(this.threadId, (t) => { t.state = "running"; t.intent = spec.intent; delete t.interrupted; });
      this.next();
    });
  }

  /** Stop the current run and run the corrected request first (with the stopped one's text for context). */
  correct(spec: RunSpec): Promise<RunResult | null> {
    const cur = this.current;
    if (cur && cur.q.spec.kind !== "reconcile") {
      cur.abortedBy = "correction";
      cur.q.execution.stopping();
      spec = { ...spec, question: `${spec.question}\n\n(This corrects the request you were working on, which was stopped: ${JSON.stringify(cur.q.spec.question)}. Do the corrected version.)` };
      this.rec.handle?.abort();
    }
    return this.enqueue({ ...spec, kind: "correction" }, true);
  }

  /**
   * The user stopped the thread's work (task.stop): the current run is aborted and its queued follow-ups dropped. The
   * thread and its session stay for what comes next. False when nothing was running.
   */
  cancel(): boolean {
    const cur = this.current;
    const dropped = this.queue.filter((q) => q.spec.kind !== "reconcile");
    if (!dropped.length && (!cur || cur.abortedBy || cur.q.spec.kind === "reconcile")) return false;
    this.queue = this.queue.filter((q) => !dropped.includes(q));
    for (const q of dropped) { q.execution.cancelQueued(); q.resolve(null); }
    if (cur && !cur.abortedBy) {
      cur.abortedBy = "user";
      cur.q.execution.stopping();
      try { this.rec.handle?.abort(); } catch { /* ignore */ }
    }
    this.store.addMessage(this.threadId, { turnId: null, role: "system", kind: "stopped", text: "Stopped by you before it finished. What it already changed stays." }, (t) => {
      t.state = "idle";
      t.awaitingReply = false;
    });
    return true;
  }

  stop(): void {
    this.stopped = true;
    for (const q of this.queue.splice(0)) { q.execution.cancelQueued(); q.resolve(null); }
    if (this.current) {
      this.current.abortedBy = "stop";
      this.current.q.execution.stopping();
    }
    const h = this.rec.handle; // the record may already be gone from the store (delete)
    try { h?.abort(); } catch { /* ignore */ }
    try { h?.close(); } catch { /* ignore */ }
  }

  private next(): void {
    if (this.stopped || this.current) return;
    const q = this.queue.shift();
    if (!q) return;
    const cur: NonNullable<ThreadRunner["current"]> = { q, abortedBy: null };
    this.current = cur;
    // Tracked so the app asks before quitting while it works (server/activity.ts).
    const end = beginTask(displayTitle(this.store.info(this.threadId)?.title ?? "a thread"));
    void this.exec(q).finally(() => {
      end(cur.abortedBy || this.stopped ? "stopped" : cur.failed ? "failed" : "done");
      this.current = null;
      this.next();
    });
  }

  private async exec(q: Queued): Promise<void> {
    const { spec, execution } = q;
    const store = this.store;
    const rec = store.get(this.threadId);
    if (!rec) { execution.cancelQueued(); return q.resolve(null); }
    this.replayCut = spec.messageId ?? null;
    // The thread's session keeps the harness, model and prompt it was opened with: a change of the smart tier (or of
    // the saved instructions) in Settings applies to threads started after it.
    const publishSession = () => {
      const session = harnessSessionInfo(rec.handle) ?? undefined;
      if (JSON.stringify(session) !== JSON.stringify(rec.info.session)) store.update(this.threadId, (t) => { t.session = session; });
    };
    // Restored from disk (server/threads/persist.ts): the session it had, on the harness and model it was opened with.
    rec.handle ??= this.deps.openThread!({
      role: "solver", choice: rec.resume?.choice ?? spec.config.llm.smart, projectFolder: execution.folder,
      replay: () => replayText(store.info(this.threadId), this.replayCut),
      replayAnnotations: () => replayAnnotations(store.info(this.threadId), this.replayCut),
      onSession: publishSession,
      ...(rec.resume ? { restore: { spec: rec.resume.spec, ...(rec.resume.ref ? { ref: rec.resume.ref } : {}) } } : {}),
    });
    delete rec.resume;
    publishSession();
    const kind = spec.kind;
    const win: RunWindow = { threadId: this.threadId, start: store.now(), end: null, files: [], kind };
    store.runLog.push(win);
    if (store.runLog.length > 200) store.runLog.splice(0, store.runLog.length - 200);
    let spoken = "";
    let text = "";
    const trace = spec.inline?.trace ?? tracer((m: ServerMsg) => store.broadcast(m), spec.turnId ?? this.threadId, this.threadId, spec.config.captureTrace);
    // Costs are counted for the model the session runs on, which may no longer be the one Settings names.
    const config: RunConfig = rec.handle.choice ? { ...spec.config, llm: { ...spec.config.llm, smart: rec.handle.choice } } : spec.config;
    try {
      const r = await execution.run(() => this.deps.solveInThread!({
        thread: rec.handle!, execution, kind, mark: spec.inline?.mark ?? noMark, question: spec.question, original: spec.original, pointing: spec.pointing ?? [],
        annotation: spec.annotation, pageContext: spec.pageContext, language: spec.language, intent: spec.intent, timeoutMs: taskTimeoutMs(spec.config),
        voiceCues: useVoiceCues(spec.config.ttsModel, spec.language),
        ...trace(),
        onSpokenLine: (l) => { spoken = l.trim(); spec.inline?.onSpokenLine(l); },
        onDelta: (d) => { text += d; spec.inline?.onDelta(d); },
      }));
      win.end = store.now();
      win.files = r.filesTouched ?? [];
      if (this.current?.abortedBy || this.stopped) return q.resolve(null);
      const result: RunResult = { text: r.text || text, spoken: spoken || spokenFallback(r.text || text) || "Done.", usage: r.usage, filesTouched: win.files };
      this.finished({ ...spec, config }, kind, result);
      q.resolve(result);
      if (kind !== "reconcile") this.reconcile(win, spec);
    } catch (e) {
      win.end = store.now();
      if (this.current?.abortedBy || this.stopped) return q.resolve(null);
      if (this.current) this.current.failed = true;
      this.failed(spec, kind, e);
      q.reject(e);
    } finally {
      publishSession();
    }
  }

  private finished(spec: RunSpec, kind: RunKind, r: RunResult): void {
    const store = this.store;
    const id = this.threadId;
    const item = llmCostItem(spec.config, "smart", r.usage, kind === "reconcile" ? "Thread solver (reconcile)" : "Thread solver");
    const result = { turnId: spec.turnId, role: "assistant" as const, kind: "result" as const, text: r.spoken, detail: r.text, filesTouched: r.filesTouched };
    if (kind === "reconcile") {
      // A system check: recorded and costed, not announced.
      store.addMessage(id, result, (t) => addCost(t, item));
      return;
    }
    const more = this.queue.some((q) => q.spec.kind !== "reconcile");
    const inTurn = spec.inline?.active() ?? false;
    store.addMessage(id, result, (t) => {
      if (!inTurn) addCost(t, item); // in a turn, the turn's own record carries the cost
      t.summary = oneLine(r.spoken);
      t.state = more ? "running" : "idle";
      t.unread = !inTurn;
      t.awaitingReply = false;
    });
    const info = store.info(id);
    if (!info) return;
    if (inTurn) return; // the turn spoke it and records it in the central conversation itself
    store.conversation.push({ turnId: `${id}:${info.messages.length}`, approach: spec.config.approach, user: "(Task update)", assistant: finishedLine(info.title, r.spoken), detail: r.text });
    this.announce(spec, r.spoken);
  }

  /**
   * Notice policy: the full result if focused (or nothing else runs), else a reminder; the thread waits pending.
   * A full result for a page the user has left is held: a short line says which page, and the result is read out
   * when they're back on it (or when they ask: tell/focus mark it told).
   */
  private announce(spec: RunSpec, spoken: string): void {
    const store = this.store;
    const id = this.threadId;
    const mode = finishMode(id, store.list());
    const info = store.info(id)!;
    const speaker = ttsSpeaker(this.deps, spec.config, spec.language);
    const addSpokenCost = (cost: CostItem | null) => { if (cost) store.update(id, (t) => addCost(t, cost)); };
    if (mode === "full") {
      if (onPage(info.pageUrl)) return void speakResult(store, id, spoken, speaker, spec.language, addSpokenCost);
      const text = awayText(info.title, info.pageUrl, spec.language);
      store.addMessage(id, { turnId: null, role: "system", kind: "reminder", text }, (t) => {
        if (t.state === "idle") t.state = "pending";
      });
      heldResults.set(id, { store, spoken, speaker, language: spec.language, addSpokenCost });
      store.speaker()?.enqueue({
        kind: "reminder", title: info.title, language: spec.language, speaker,
        say: { sayId: `${id}:${info.messages.length}`, threadId: id, text, needsReply: false },
        valid: () => store.info(id)?.unread === true && !onPage(store.info(id)?.pageUrl),
        onDone: (_outcome, cost) => addSpokenCost(cost),
      });
      return;
    }
    const text = reminderText([info.title], spec.language);
    store.addMessage(id, { turnId: null, role: "system", kind: "reminder", text }, (t) => {
      if (t.state === "idle") t.state = "pending";
    });
    store.speaker()?.enqueue({
      kind: "reminder", title: info.title, language: spec.language, speaker,
      say: { sayId: `${id}:${info.messages.length}`, threadId: id, text, needsReply: false },
      valid: () => store.info(id)?.unread === true,
      onDone: (_outcome, cost) => addSpokenCost(cost),
    });
  }

  private failed(spec: RunSpec, kind: RunKind, e: unknown): void {
    if (kind === "reconcile") return void console.warn("[threads] reconcile failed", e);
    const store = this.store;
    const id = this.threadId;
    const message = e instanceof Error ? e.message : String(e);
    const more = this.queue.length > 0;
    store.addMessage(id, { turnId: spec.turnId, role: "system", kind: "error", text: message }, (t) => { t.state = more ? "running" : "failed"; });
    const info = store.info(id);
    // Spoken only for the thread the user dealt with last, and only while they're on its page (else it's just the red marker).
    if (!info || spec.inline?.active() || store.focused() !== id || !onPage(info.pageUrl)) return;
    store.speaker()?.enqueue({
      kind: "result", language: spec.language, speaker: ttsSpeaker(this.deps, spec.config, spec.language),
      say: { sayId: `${id}:${info.messages.length}`, threadId: id, text: failureText(info.title, spec.language), needsReply: false },
      valid: () => store.info(id) !== undefined,
    });
  }

  /** Another thread's run overlapped this one in time and touched a same file: one follow-up here (finished later). */
  private reconcile(win: RunWindow, spec: RunSpec): void {
    if (!win.files.length || this.stopped) return;
    const mine = new Set(win.files);
    const shared = new Set<string>();
    for (const o of this.store.runLog) {
      if (o === win || o.threadId === win.threadId || o.end === null || o.kind === "reconcile") continue;
      if (o.start >= win.end! || o.end <= win.start) continue; // no overlap
      if (o.end > win.end!) continue; // the other one finished later: it reconciles itself
      for (const f of o.files) if (mine.has(f)) shared.add(f);
    }
    if (!shared.size) return;
    const text = reconcileText([...shared]);
    const msg = this.store.addMessage(this.threadId, { turnId: null, role: "system", kind: "reconcile", text });
    void this.enqueue({ kind: "reconcile", question: text, turnId: null, config: spec.config, intent: "task", language: spec.language, messageId: msg?.id }).catch(() => {});
  }
}

function addCost(t: ThreadInfo, item: CostItem): void {
  t.costItems = [...(t.costItems ?? []), item];
  t.costUsd = (t.costUsd ?? 0) + item.usd;
}

function oneLine(s: string): string {
  const l = stripVoiceCues(s).replace(/\s+/g, " ").trim(); // shown text, so no Drama 3 cues
  return l.length > SUMMARY_MAX ? `${l.slice(0, SUMMARY_MAX - 1)}…` : l;
}

/** The thread's history as plain text, for a session that has to be (re)opened. */
export function replayText(t: ThreadInfo | undefined, cut: string | null = null): string {
  if (!t) return "";
  const i = cut ? t.messages.findIndex((m) => m.id === cut) : -1;
  const lines = fitLines((i >= 0 ? t.messages.slice(0, i) : t.messages).flatMap((m) => {
    if (m.kind === "reminder" || m.kind === "ack") return [];
    const who = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "System";
    const body = m.kind === "result" ? (m.detail || m.text) : m.text;
    const files = m.filesTouched?.length ? `\n(Edited: ${m.filesTouched.join(", ")})` : "";
    return [`${who} (${m.kind}): ${body}${files}${m.annotation ? `\n${drawingContext(m.annotation)}` : ""}`];
  }));
  if (!lines.length) return "";
  return `Earlier in this thread about ${t.title} (a session that has since been closed):\n${lines.join("\n\n")}`;
}

export function replayAnnotations(t: ThreadInfo | undefined, cut: string | null = null): DrawingAnnotation[] {
  const i = cut ? t?.messages.findIndex(m => m.id === cut) ?? -1 : -1;
  return (i >= 0 ? t!.messages.slice(0, i) : t?.messages ?? []).flatMap(m => m.annotation ? [m.annotation] : []).slice(-8);
}

function runnerOf(store: ThreadStore, threadId: string, deps: ThreadDeps): ThreadRunner | null {
  const rec = store.get(threadId);
  if (!rec) return null;
  if (!(rec.run instanceof ThreadRunner)) rec.run = new ThreadRunner(store, threadId, rec, deps);
  return rec.run as ThreadRunner;
}

/** Queue a request (new thread or follow-up). Resolves with the result, or null if it was stopped/superseded. */
export function submitRun(threadId: string, spec: RunSpec, deps: ThreadDeps, store = threadStore()): Promise<RunResult | null> {
  const r = runnerOf(store, threadId, deps);
  return r ? r.enqueue(spec) : Promise.resolve(null);
}

/** A correction: aborts the current run and runs the combined request next. */
export function correctRun(threadId: string, spec: RunSpec, deps: ThreadDeps, store = threadStore()): Promise<RunResult | null> {
  const r = runnerOf(store, threadId, deps);
  return r ? r.correct(spec) : Promise.resolve(null);
}

/** The user stopped the thread's work (task.stop). False when it wasn't working. */
export function cancelRun(threadId: string, store = threadStore()): boolean {
  const run = store.get(threadId)?.run;
  return run instanceof ThreadRunner && run.cancel();
}

/** The thread has a run in flight. */
export function isRunning(threadId: string, store = threadStore()): boolean {
  const run = store.get(threadId)?.run;
  return run instanceof ThreadRunner && run.busy;
}
