// What the server is working on right now: element-thread runs, background jobs and the conversation's own turns.
// The Electron shell asks before it quits while something is working, and can keep the app running in the
// background until the work is done (electron/main.ts, "quitting"). Each piece of work calls beginTask() when it
// starts and the returned function when it ends; listeners hear every change.

export type TaskOutcome = "done" | "failed" | "stopped";

export interface ActivityChange {
  /** Titles of what's working now, oldest first. */
  running: string[];
  /** The task that just ended, if this change is an end. */
  finished?: { title: string; outcome: TaskOutcome };
}

const running = new Map<number, string>();
const listeners = new Set<(c: ActivityChange) => void>();
let seq = 0;

/** Start tracking a piece of work. The returned function ends it (only the first call counts). */
export function beginTask(title: string): (outcome?: TaskOutcome) => void {
  const id = ++seq;
  running.set(id, title);
  emit();
  return (outcome = "done") => {
    if (!running.delete(id)) return;
    emit({ title, outcome });
  };
}

export function runningTasks(): string[] { return [...running.values()]; }

export function onActivity(fn: (c: ActivityChange) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function emit(finished?: ActivityChange["finished"]): void {
  const change: ActivityChange = { running: runningTasks(), ...(finished ? { finished } : {}) };
  for (const fn of [...listeners]) {
    try { fn(change); } catch (e) { console.warn("[activity] listener failed", e); }
  }
}
