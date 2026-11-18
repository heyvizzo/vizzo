import type { DrawingAnnotation } from "../../shared/annotations.ts";
// Harness sessions (docs/PLAN-threads.md; docs/ARCHITECTURE.md "Harness sessions"): the central conversation, each
// element thread and each long job runs on one session of its harness, kept across requests so the harness keeps
// its own context (harnesses.ts: claude-code's process stays open, codex's thread takes more turns, opencode's
// session more messages, pi/omp more prompts, grok resumes its saved session per request).
// What a session runs with (the "solver" spec: prompt and saved instructions, project folder, switches, model and
// level) is fixed at its first request: a change in Settings applies to sessions opened after it.
// The harness saves the session itself, so a request without a live process (evicted, crashed, timed out) resumes
// it by id, with everything the harness kept (its tool results too). A session can also start as a fork of another
// (`forkOf`). Only when there is nothing to continue natively (or the resume doesn't take) does the new session get
// `replay()`, Vizzo's own record of the history, before the message. A stop ends the request, not the session.
// At most MAX_LIVE_THREAD_SESSIONS processes stay live: the least recently used idle one is stopped (and resumed
// when it's needed again). `close()` stops a session for good; its saved session stays on disk for the user.
import type { LlmChoice } from "../../shared/config.ts";
import { MAX_LIVE_THREAD_SESSIONS } from "../../shared/threads.ts";
import { projectDir } from "../project.ts";
import type { WriterExecution } from "../changes/writers.ts";
import { HarnessTurn, SessionUnavailableError, type AgentSpec, type SessionRef, type SessionStart, type WarmAgent } from "./harnesses.ts";
import type { HarnessThread, OpenHarnessThread, OpenHarnessThreadOpts, SessionDispatch, SessionMode } from "./types.ts";
import { agentSpec, releaseSessionAgent, releaseSessionAgentForResume, takeSessionAgent } from "./warmPool.ts";

type ThreadResult = Awaited<ReturnType<HarnessThread["send"]>>;

/** After an abort, how long the next request waits for the stopped one to wind down before the process is dropped. */
const ABORT_SETTLE_MS = 5000;

/** The message a session without the history gets: the history (or the notes), then the request. */
export const withReplay = (replay: string, user: string): string => `${replay}\n\n---\n\n${user}`;

const abortError = (): Error => Object.assign(new Error("The thread's request was stopped"), { name: "AbortError" });
const closedError = (): Error => new Error("The thread is closed");

/** Sessions with an agent attached. */
const attached = new Set<Thread>();
let seq = 0;
/** Use order for the LRU (a counter: several requests can end in the same millisecond). */
let useSeq = 0;

class Thread implements HarnessThread {
  readonly id = `hthread-${++seq}`;
  private agent: WarmAgent | null = null;
  /** Fixed at the first request. */
  private pinned: AgentSpec | null = null;
  /** The harness's saved session, once there is one: what a request without a live process resumes. */
  private ref: SessionRef | undefined;
  /** A request has reached a session of its own (so it no longer starts as a fork). */
  private begun = false;
  /** Requests run one after another: each waits for this. */
  private tail: Promise<void> = Promise.resolve();
  private stop: (() => void) | null = null;
  private activeSettled?: Promise<void>;
  private closed = false;
  private sessionKey = "";
  readonly projectFolder: string | null;
  busy = false;
  lastUsed = 0;

  constructor(private opts: OpenHarnessThreadOpts) {
    this.projectFolder = opts.restore ? opts.restore.spec.project ?? null
      : opts.projectFolder !== undefined ? opts.projectFolder : projectDir();
    if (opts.restore) {
      this.pinned = opts.restore.spec;
      this.ref = opts.restore.ref;
      this.begun = true;
    }
  }
  get choice(): LlmChoice { return this.opts.choice; }
  get spec(): AgentSpec | undefined { return this.pinned ?? undefined; }

  get live(): boolean { return !!this.agent?.alive(); }
  get settled(): Promise<void> { return this.activeSettled ?? Promise.resolve(); }

  pid(): number | undefined { return this.live ? this.agent!.pid?.() : undefined; }

  session(): SessionRef | undefined { return this.agent?.session?.() ?? this.ref; }

  private notifySession(execution?: WriterExecution): void {
    const session = this.session();
    execution?.observeNativeSession(session?.id);
    const key = JSON.stringify([this.pinned?.harness, this.pinned?.project, session]);
    if (key === this.sessionKey) return;
    this.sessionKey = key;
    this.opts.onSession?.();
  }

  send(user: string, onText: ((d: string) => void) | undefined, timeoutMs: number, annotations?: readonly DrawingAnnotation[], onDispatch?: (d: SessionDispatch) => void, execution?: WriterExecution): Promise<ThreadResult> {
    if (this.closed) return Promise.reject(closedError());
    return new Promise<ThreadResult>((resolve, reject) => {
      this.tail = this.tail.then(() => this.run(user, onText, timeoutMs, resolve, reject, annotations, onDispatch, execution));
    });
  }

  abort(): void {
    const stop = this.stop;
    if (!stop) return;
    stop();
    // The harness stops the turn and keeps the session; one that can't is stopped whole (and resumed next time).
    if (this.agent?.abort) this.agent.abort();
    else this.drop();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort();
    if (this.activeSettled) void this.activeSettled.then(() => this.drop());
    else this.drop();
  }

  release(): Promise<void> {
    // Serialize with sends: finish existing work, release the writer, then allow later Vizzo requests to resume.
    const released = this.tail.then(async () => {
      const agent = this.agent;
      if (!agent) return;
      this.ref = agent.session?.() ?? this.ref;
      await releaseSessionAgentForResume(agent);
      if (this.agent === agent) { this.agent = null; attached.delete(this); }
    });
    this.tail = released.catch(() => {});
    return released;
  }

  /** Release the agent (evicted, dead, closed). The saved session stays. */
  drop(): void {
    const a = this.agent;
    this.agent = null;
    attached.delete(this);
    if (!a) return;
    this.ref = a.session?.() ?? this.ref;
    releaseSessionAgent(a);
  }

  /**
   * An agent for this request and the message it gets. A live one continues; otherwise the saved session is resumed,
   * or (first request) another's forked; `fresh`: a new session, told the history by `replay()`.
   */
  private attach(user: string, annotations: readonly DrawingAnnotation[], fresh: boolean): { agent: WarmAgent; mode: SessionMode; message: string; images: DrawingAnnotation[] } {
    let mode: SessionMode = "live";
    if (fresh || !this.agent?.alive()) {
      this.drop();
      enforceCap(MAX_LIVE_THREAD_SESSIONS - 1, this);
      const forkRef = this.begun ? undefined : this.opts.forkOf?.session?.();
      const start: SessionStart = fresh ? { kind: "new" } : this.ref ? { kind: "resume", ref: this.ref } : forkRef ? { kind: "fork", ref: forkRef } : { kind: "new" };
      if (fresh) this.ref = undefined;
      this.agent = takeSessionAgent(this.pinned!, start);
      attached.add(this);
      mode = start.kind === "resume" ? "resumed" : start.kind === "fork" ? "forked" : "new";
    }
    let message = user;
    let images = [...annotations];
    if (mode === "new") {
      const replay = this.opts.replay().trim();
      if (replay) {
        mode = "replayed";
        message = withReplay(replay, user);
        images = [...(this.opts.replayAnnotations?.() ?? []), ...images];
      }
    } else {
      // The session has its own history: it only hears what happened elsewhere since.
      const notes = this.opts.notes?.().trim();
      if (notes) message = withReplay(notes, user);
    }
    const seen = new Set<string>();
    images = images.reverse().filter(a => { if (seen.has(a.id)) return false; seen.add(a.id); return true; }).reverse();
    if (images.length) message += `\n\nAttached images, in order: ${images.map(a => a.id).join(", ")}. Match these IDs to the drawing context above.`;
    return { agent: this.agent!, mode, message, images };
  }

  /** One request; resolves (never rejects) once its agent is free for the next one. */
  private async run(
    user: string, onText: ((d: string) => void) | undefined, timeoutMs: number,
    resolve: (r: ThreadResult) => void, reject: (e: unknown) => void, annotations?: readonly DrawingAnnotation[], onDispatch?: (d: SessionDispatch) => void,
    execution?: WriterExecution,
  ): Promise<void> {
    if (this.closed) { reject(closedError()); return; }
    if (execution?.stopRequested) { reject(abortError()); return; }
    const requiredSession = execution?.requiredSessionId;
    if (requiredSession && this.session()?.id !== requiredSession) {
      reject(new Error("The native session for this unfinished request is no longer available."));
      return;
    }
    this.busy = true;
    let settled!: () => void;
    this.activeSettled = new Promise<void>((resolve) => { settled = resolve; });
    this.lastUsed = ++useSeq;
    let aborted = false;
    let turn: HarnessTurn | undefined;
    const stopped = new Promise<never>((_, rej) => {
      this.stop = () => { aborted = true; turn?.stop(); rej(abortError()); };
    });
    stopped.catch(() => {});
    let agent: WarmAgent | null = null;
    let legacySettled: Promise<boolean> = Promise.resolve(true);
    let fallback: string | undefined;
    try {
      // What the session runs with is read once: a later change in Settings is for sessions opened after it.
      this.pinned ??= agentSpec(this.opts.role, this.opts.choice, true, this.projectFolder);
      for (let attempt = 0; ; attempt++) {
        let at: ReturnType<Thread["attach"]>;
        try {
          at = this.attach(user, annotations ?? [], fallback !== undefined);
        } catch (e) {
          // The saved session is known to be gone before anything was sent: a new one, told the history.
          if (requiredSession || !(e instanceof SessionUnavailableError) || attempt > 0) throw e;
          fallback = e.message;
          continue;
        }
        agent = at.agent;
        const { mode, message, images } = at;
        this.notifySession(execution);
        const known = agent.session?.() ?? (mode === "resumed" ? this.ref : undefined);
        if (requiredSession && known?.id !== requiredSession) throw new Error("The harness reopened a different native session.");
        onDispatch?.({ mode, message, ...(known ? { sessionId: known.id } : {}), ...(fallback ? { fallback } : {}) });
        const a = agent;
        const nativeTurn = turn = new HarnessTurn(execution);
        const inner = Promise.resolve().then(() => {
          if (aborted) throw abortError();
          const request = a.request(message, (d) => {
            this.notifySession(execution);
            if (!aborted) onText?.(d);
          }, timeoutMs, images, nativeTurn);
          this.notifySession(execution); // Some harnesses allocate their id synchronously when the request starts.
          return request;
        });
        legacySettled = inner.then(() => true, () => true);
        try {
          const r = await Promise.race([inner, stopped]);
          this.begun = true;
          this.ref = a.session?.() ?? this.ref;
          resolve({
            ...r, filesTouched: r.filesTouched ?? [], reopened: mode === "replayed",
            session: { mode, ...(this.ref ? { id: this.ref.id, ...(this.ref.file ? { file: this.ref.file } : {}) } : {}), ...(fallback ? { fallback } : {}) },
          });
          break;
        } catch (e) {
          // The resume (or fork) didn't take and nothing reached a session: once more on a new one, told the history.
          if (!requiredSession && e instanceof SessionUnavailableError && !aborted && attempt === 0) {
            await nativeTurn.settled;
            fallback = e.message;
            continue;
          }
          if (!(e instanceof SessionUnavailableError)) { this.begun = true; this.ref = a.session?.() ?? this.ref; }
          throw e;
        }
      }
    } catch (e) {
      reject(aborted ? abortError() : e);
    } finally {
      this.stop = null;
    }
    try {
      if (turn?.settled) await turn.settled;
      else if (aborted && agent) {
        // Legacy test agents have no protocol barrier. Production adapters always register one once dispatched.
        const wound = await Promise.race([legacySettled, new Promise<boolean>((r) => setTimeout(() => r(false), ABORT_SETTLE_MS).unref())]);
        if (!wound && this.agent === agent) this.drop();
      }
      // Crashed, killed or timed out: the next request resumes the saved session in a new process.
      if (agent && this.agent === agent && !agent.alive()) this.drop();
    } finally {
      this.busy = false;
      this.lastUsed = ++useSeq;
      this.activeSettled = undefined;
      settled();
      this.notifySession(execution);
      enforceCap(MAX_LIVE_THREAD_SESSIONS);
    }
  }
}

/** Stop least-recently-used idle sessions' processes until at most `limit` are live (besides `except`). Busy ones wait. */
function enforceCap(limit: number, except?: Thread): void {
  for (const t of [...attached]) if (!t.live && !t.busy) t.drop();
  const others = [...attached].filter((t) => t !== except);
  const idle = others.filter((t) => !t.busy).sort((a, b) => a.lastUsed - b.lastUsed);
  let count = others.length;
  for (const t of idle) {
    if (count <= limit) break;
    t.drop();
    count--;
  }
}

export const openHarnessThread: OpenHarnessThread = (opts) => new Thread(opts);

/** Sessions live right now (status, tests). */
export function liveHarnessSessions(): number { return [...attached].filter((t) => t.live).length; }
