import type { DrawingAnnotation } from "../../shared/annotations.ts";
// Element threads' harness sessions (docs/PLAN-threads.md): one agent per thread, kept across requests so the
// harness keeps its own context (harnesses.ts `keep`: claude-code's process stays open, codex's thread takes more
// turns, opencode's session more messages, pi/omp more prompts; grok is cold, so every request is a new agent).
// The agent comes from warmPool.ts (the "solver" spec: same prompt, project folder, tools, model and level as
// solveTask). Without a live session (first use, evicted, crashed, aborted claude-code, grok) the next request
// opens one and sends `replay()` before the message. At most MAX_LIVE_THREAD_SESSIONS stay live: the least
// recently used idle one is closed.
import type { LlmChoice } from "../../shared/config.ts";
import { MAX_LIVE_THREAD_SESSIONS } from "../../shared/threads.ts";
import type { WarmAgent } from "./harnesses.ts";
import type { HarnessThread, OpenHarnessThread, OpenHarnessThreadOpts } from "./types.ts";
import { releaseThreadAgent, takeThreadAgent } from "./warmPool.ts";

type ThreadResult = Awaited<ReturnType<HarnessThread["send"]>>;

/** After an abort, how long the next request waits for the stopped one to wind down before the session is dropped. */
const ABORT_SETTLE_MS = 5000;

/** The message a new session gets: the thread's history, then the request. */
export const withReplay = (replay: string, user: string): string => `${replay}\n\n---\n\n${user}`;

const abortError = (): Error => Object.assign(new Error("The thread's request was stopped"), { name: "AbortError" });
const closedError = (): Error => new Error("The thread is closed");

/** Threads with an agent attached. */
const attached = new Set<Thread>();
let seq = 0;
/** Use order for the LRU (a counter: several requests can end in the same millisecond). */
let useSeq = 0;

class Thread implements HarnessThread {
  readonly id = `hthread-${++seq}`;
  private agent: WarmAgent | null = null;
  /** Requests run one after another: each waits for this. */
  private tail: Promise<void> = Promise.resolve();
  private stop: (() => void) | null = null;
  private closed = false;
  busy = false;
  lastUsed = 0;

  constructor(private opts: OpenHarnessThreadOpts) {}
  get choice(): LlmChoice { return this.opts.choice; }

  get live(): boolean { return !!this.agent?.alive(); }

  pid(): number | undefined { return this.live ? this.agent!.pid?.() : undefined; }

  send(user: string, onText: ((d: string) => void) | undefined, timeoutMs: number, annotations?: readonly DrawingAnnotation[]): Promise<ThreadResult> {
    if (this.closed) return Promise.reject(closedError());
    return new Promise<ThreadResult>((resolve, reject) => {
      this.tail = this.tail.then(() => this.run(user, onText, timeoutMs, resolve, reject, annotations));
    });
  }

  abort(): void {
    const stop = this.stop;
    if (!stop) return;
    stop();
    // No interrupt (claude-code): the process goes, the next request reopens with the replay.
    if (this.agent?.abort) this.agent.abort();
    else this.drop();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort();
    this.drop();
  }

  /** Release the agent (evicted, dead, closed). */
  drop(): void {
    const a = this.agent;
    this.agent = null;
    attached.delete(this);
    if (a) releaseThreadAgent(a);
  }

  /** One request; resolves (never rejects) once its agent is free for the next one. */
  private async run(
    user: string, onText: ((d: string) => void) | undefined, timeoutMs: number,
    resolve: (r: ThreadResult) => void, reject: (e: unknown) => void, annotations?: readonly DrawingAnnotation[],
  ): Promise<void> {
    if (this.closed) { reject(closedError()); return; }
    this.busy = true;
    this.lastUsed = ++useSeq;
    let reopened = false;
    let message = user;
    let images = [...(annotations ?? [])];
    let agent: WarmAgent;
    try {
      if (!this.agent?.alive()) {
        this.drop();
        enforceCap(MAX_LIVE_THREAD_SESSIONS - 1, this);
        const replay = this.opts.replay().trim();
        images = [...(this.opts.replayAnnotations?.() ?? []), ...images];
        this.agent = takeThreadAgent(this.opts.role, this.opts.choice);
        attached.add(this);
        if (replay) { reopened = true; message = withReplay(replay, user); }
      }
      agent = this.agent!;
    } catch (e) {
      this.busy = false;
      reject(e);
      return;
    }

    const seen = new Set<string>();
    images = images.reverse().filter(a => { if (seen.has(a.id)) return false; seen.add(a.id); return true; }).reverse();
    if (images.length) message += `\n\nAttached images, in order: ${images.map(a => a.id).join(", ")}. Match these IDs to the drawing context above.`;
    let aborted = false;
    const inner = Promise.resolve().then(() => agent.request(message, (d) => { if (!aborted) onText?.(d); }, timeoutMs, images));
    const settled = inner.then(() => true, () => true);
    const stopped = new Promise<never>((_, rej) => { this.stop = () => { aborted = true; rej(abortError()); }; });
    stopped.catch(() => {});
    try {
      const r = await Promise.race([inner, stopped]);
      resolve({ ...r, filesTouched: r.filesTouched ?? [], reopened });
    } catch (e) {
      reject(aborted ? abortError() : e);
    } finally {
      this.stop = null;
    }
    if (aborted) {
      const wound = await Promise.race([settled, new Promise<boolean>((r) => setTimeout(() => r(false), ABORT_SETTLE_MS).unref())]);
      if (!wound && this.agent === agent) this.drop();
    }
    this.busy = false;
    this.lastUsed = ++useSeq;
    // Crashed, killed, or a one-request agent (grok): the next request opens a new session.
    if (this.agent === agent && !agent.alive()) this.drop();
    enforceCap(MAX_LIVE_THREAD_SESSIONS);
  }
}

/** Close least-recently-used idle sessions until at most `limit` are live (besides `except`). Busy ones wait. */
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
