// Helpers shared by the orchestrators: a lazily-opened per-turn Scribe stream, and the per-connection
// reusable OpenAI Realtime session.
import { readFileSync } from "node:fs";
import type { RealtimeModel } from "../../shared/config.ts";
import type { RealtimeSession, RealtimeUsage, RealtimeUsageTotals, SttStream, ToolCall } from "../adapters/types.ts";
import { ASK_OPUS_TOOL } from "../adapters/types.ts";
import type { Mark } from "../clock.ts";
import type { OrchestratorDeps, TurnContext } from "./types.ts";
import type { TurnBase } from "./turnBase.ts";

// ── Scribe (one session per turn) ──────────────────────────────────────────

/**
 * Per-turn Scribe stream. `open()` is idempotent; audio pushed before the socket is open is buffered.
 * Partials go to the client as `stt.partial`.
 */
export class LazyScribe {
  private p: Promise<SttStream> | null = null;
  private stream: SttStream | null = null;
  private buf: Buffer[] = [];
  private committed = false;

  constructor(private base: TurnBase, private deps: Pick<OrchestratorDeps, "openScribe">) {}

  open(): Promise<SttStream> {
    if (!this.p) {
      this.p = this.base.track(this.deps.openScribe({ mark: this.base.mark })).then((s) => {
        this.stream = s;
        s.onPartial((t) => this.base.sttPartial(t));
        for (const b of this.buf.splice(0)) s.pushAudio(b);
        if (this.committed) s.commit();
        return s;
      });
      this.p.catch(() => {}); // callers observe the rejection where it matters
    }
    return this.p;
  }

  push(pcm: Buffer): void {
    if (this.committed) return;
    if (this.stream) this.stream.pushAudio(pcm);
    else this.buf.push(pcm);
  }

  /** Commit (now, or as soon as the socket opens) and wait for the final transcript. */
  async final(): Promise<{ text: string; words: import("../../shared/protocol.ts").Word[] }> {
    const s = await this.open();
    if (!this.committed) { this.committed = true; s.commit(); }
    return s.final();
  }

  /** Mark committed right away so later audio is dropped even if the socket isn't open yet. */
  commit(): void {
    if (this.committed) return;
    this.committed = true;
    this.stream?.commit();
  }

  get seconds(): number { return this.stream?.seconds ?? 0; }
}

// ── OpenAI Realtime (one session per connection, reused across turns) ─────

const REALTIME_INSTRUCTIONS = readFileSync(new URL("../prompts/realtime.md", import.meta.url), "utf8").trim();
const CACHE_KEY = "realtime";

/** Per-turn callbacks; the session's own callbacks are registered once and dispatch to the current listener. */
export interface RealtimeListener {
  onAudio(pcm: Buffer): void;
  onText(delta: string): void;
  onToolCall(call: ToolCall): void;
  onError(err: Error): void;
}

class RealtimeHolder {
  listener: RealtimeListener | null = null;
  dead = false;
  /** Chat turns this session has in its own history (it handled them, or got them as a recap). */
  readonly seenTurns = new Set<string>();
  constructor(readonly session: RealtimeSession, readonly model: RealtimeModel) {
    session.onAudio((b) => this.listener?.onAudio(b));
    session.onText((d) => this.listener?.onText(d));
    session.onToolCall((c) => this.listener?.onToolCall(c));
    session.onError((e) => {
      // Treat any error as fatal for the session: the next turn reopens a fresh one.
      this.dead = true;
      this.listener?.onError(e);
    });
  }
}

interface CacheEntry { model: RealtimeModel; ready: Promise<RealtimeHolder>; holder?: RealtimeHolder }

export interface RealtimeLease {
  session: RealtimeSession;
  /** True when the session was opened for this turn only (prewarm off). */
  cold: boolean;
  /** True when an already-open session from an earlier turn was reused. */
  reused: boolean;
  /** Usage of this turn only (the session's counters are cumulative). */
  turnUsage(): RealtimeUsage;
  /** Chat turn IDs already in this session's conversation (chat mode). */
  seenTurns: Set<string>;
  /** Detach from the turn. `inFlight`: a response may still be running, so the session is closed and dropped. */
  release(inFlight: boolean): void;
}

function snapshot(u: RealtimeUsage): { n: number; totals: RealtimeUsageTotals } {
  return { n: u.responses.length, totals: { ...u.totals } };
}

export function diffUsage(now: RealtimeUsage, base: { n: number; totals: RealtimeUsageTotals }): RealtimeUsage {
  const totals = { ...now.totals };
  for (const k of Object.keys(totals) as (keyof RealtimeUsageTotals)[]) totals[k] -= base.totals[k];
  return { responses: now.responses.slice(base.n), totals };
}

function openOpts(ctx: TurnContext, mark: Mark) {
  return { mark, model: ctx.config.realtimeModel, instructions: REALTIME_INSTRUCTIONS, tools: [ASK_OPUS_TOOL] };
}

/**
 * Get a Realtime session for this turn. Warm (`reuse`): the connection's cached session, opened on first
 * use and reopened if it errored/closed or the model changed. Cold: a fresh session closed after the turn.
 * The listener is attached before returning; call `beginTurn()` + `setMark()` yourself.
 */
export async function acquireRealtime(
  ctx: TurnContext, deps: Pick<OrchestratorDeps, "openRealtime">, mark: Mark, listener: RealtimeListener, reuse: boolean,
): Promise<RealtimeLease> {
  if (!reuse) {
    const holder = new RealtimeHolder(await deps.openRealtime(openOpts(ctx, mark)), ctx.config.realtimeModel);
    holder.listener = listener;
    const base = snapshot(holder.session.usage);
    return {
      session: holder.session, cold: true, reused: false, seenTurns: holder.seenTurns,
      turnUsage: () => diffUsage(holder.session.usage, base),
      release: () => { holder.listener = null; holder.session.close(); },
    };
  }

  let entry = ctx.connection.get<CacheEntry>(CACHE_KEY);
  if (entry && (entry.model !== ctx.config.realtimeModel || entry.holder?.dead)) {
    ctx.connection.delete(CACHE_KEY);
    entry = undefined;
  }
  const reused = !!entry?.holder;
  if (!entry) {
    const e: CacheEntry = {
      model: ctx.config.realtimeModel,
      ready: deps.openRealtime(openOpts(ctx, mark)).then((s) => (e.holder = new RealtimeHolder(s, e.model))),
    };
    e.ready.catch(() => { if (ctx.connection.get(CACHE_KEY) === e) ctx.connection.delete(CACHE_KEY); });
    ctx.connection.set<CacheEntry>(CACHE_KEY, e, (v) => {
      v.ready.then((h) => { h.listener = null; h.session.close(); }, () => {});
    });
    entry = e;
  }
  const current = entry;
  const holder = await current.ready;
  if (holder.dead) throw new Error("realtime session failed before the turn started");
  holder.listener = listener;
  const base = snapshot(holder.session.usage);
  return {
    session: holder.session, cold: false, reused, seenTurns: holder.seenTurns,
    turnUsage: () => diffUsage(holder.session.usage, base),
    release: (inFlight) => {
      if (holder.listener === listener) holder.listener = null;
      if (holder.dead) {
        // Errored: drop it; the next turn reopens (and gets a history recap).
        if (ctx.connection.get(CACHE_KEY) === current) ctx.connection.delete(CACHE_KEY);
        else holder.session.close();
      } else if (inFlight) {
        // Interrupted mid-response: cancel it and keep the session. The next beginTurn() marks the
        // cancelled response stale, so none of its late audio leaks into the next turn.
        holder.session.cancelResponse();
      }
    },
  };
}

/** Drop the connection's Realtime session (chat "New conversation": its history lives in the session). */
export function dropRealtime(conn: TurnContext["connection"]): void {
  conn.delete(CACHE_KEY);
}

/** The connection's Realtime session when it's open, healthy and not in use by a turn (background notices). */
export function idleRealtime(conn: TurnContext["connection"]): {
  session: RealtimeSession;
  seenTurns: Set<string>;
  /** Route the session's output to `l` (null to detach). Returns false if a turn took the session meanwhile. */
  attach(l: RealtimeListener | null): boolean;
} | null {
  const holder = conn.get<CacheEntry>(CACHE_KEY)?.holder;
  if (!holder || holder.dead || holder.listener) return null;
  let mine: RealtimeListener | null = null;
  return {
    session: holder.session,
    seenTurns: holder.seenTurns,
    attach(l) {
      if (holder.listener && holder.listener !== mine) return false;
      holder.listener = mine = l;
      return true;
    },
  };
}

