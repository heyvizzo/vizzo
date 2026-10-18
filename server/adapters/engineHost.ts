// Lifecycle of the on-device engines' helper processes (localTts.ts, localStt.ts): at most one per engine, started on
// demand, and its state (loading → ready, or error) for the Settings page. Stopping kills the process at once, even
// while it's still loading its model. A failed start stays listed (with its error) until the engine is stopped or
// started again.
import type { EngineState } from "../../shared/protocol.ts";

/** A helper process that loads a model and then says it's ready. */
export interface HostedHelper {
  readonly ready: Promise<void>;
  dead: boolean;
  readonly pid: number | undefined;
  kill(): void;
}

interface Entry<H> {
  helper: Promise<H>;
  /** Set once the process is spawned. */
  proc?: H;
  state: "loading" | "ready" | "error";
  error?: string;
  loadMs?: number;
  stopped?: boolean;
}

export class EngineHost<E extends string, H extends HostedHelper> {
  private entries = new Map<E, Entry<H>>();
  log: (msg: string) => void = (msg) => console.info(msg);

  /** `spawn`: start the engine's helper (throws with a fix-it message if it isn't installed). */
  constructor(private tag: string, private labels: Record<E, string>, private spawn: (engine: E) => Promise<H>) {
    process.once("exit", () => this.stop());
  }

  /** Start an engine's helper (model loaded + warmed). Idempotent; retries one that failed. */
  start(engine: E): Promise<void> {
    let entry = this.entries.get(engine);
    if (!entry || entry.state === "error") {
      const t0 = performance.now();
      const e: Entry<H> = { state: "loading", helper: null as unknown as Promise<H> };
      e.helper = this.spawn(engine).then(async (helper) => {
        e.proc = helper;
        if (e.stopped) helper.kill();
        await helper.ready;
        e.state = "ready";
        e.loadMs = Math.round(performance.now() - t0);
        this.log(`[${this.tag}] ${this.labels[engine]} ready in ${e.loadMs} ms (model loaded, warmed)`);
        return helper;
      });
      e.helper.catch((err) => {
        e.state = "error";
        e.error = err instanceof Error ? err.message : String(err);
        if (!e.stopped) this.log(`[${this.tag}] ${this.labels[engine]} unavailable: ${e.error}`);
      });
      this.entries.set(engine, e);
      entry = e;
    }
    return entry.helper.then(() => {});
  }

  /** The running helper, started if it isn't (a turn can use an engine that isn't selected). */
  async get(engine: E): Promise<H> {
    this.start(engine).catch(() => {});
    const h = await this.entries.get(engine)!.helper;
    if (h.dead) { this.entries.delete(engine); return this.get(engine); }
    return h;
  }

  /** Kill an engine's helper (all of them without an argument). */
  stop(engine?: E): void {
    for (const e of engine ? [engine] : [...this.entries.keys()]) {
      const entry = this.entries.get(e);
      if (!entry) continue;
      entry.stopped = true;
      entry.proc?.kill();
      this.entries.delete(e);
    }
  }

  /** Engines that are loading or running, and the last failure of one that couldn't start. */
  states(): (Omit<EngineState, "kind" | "ramBytes"> & { pid?: number })[] {
    return [...this.entries].map(([engine, e]) => {
      const dead = e.state === "ready" && e.proc?.dead;
      return {
        engine, label: this.labels[engine], state: dead ? "error" : e.state,
        ...(dead ? { error: "the helper process exited" } : e.error ? { error: e.error } : {}),
        ...(e.loadMs !== undefined ? { loadMs: e.loadMs } : {}),
        ...(e.proc?.pid ? { pid: e.proc.pid } : {}),
      };
    });
  }
}
