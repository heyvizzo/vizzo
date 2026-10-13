import { isMarkedSegment } from "../../shared/marks.ts";
// Shared per-turn plumbing for the A/B/C orchestrators: ordered audio segments, text accumulation,
// socket cleanup, the overall turn timeout and "finish exactly once" semantics.
import type { MarkName } from "../../shared/marks.ts";
import { resolvePointing } from "../../shared/pointing.ts";
import type { PointingTarget, Segment, Usage, Word } from "../../shared/protocol.ts";
import type { Mark } from "../clock.ts";
import type { TurnContext, TurnResult } from "./types.ts";

export const DEFAULT_TURN_TIMEOUT_MS = 60_000;

export type CleanupReason = "done" | "cancel" | "error";

/** One audio segment ("ack" or "answer") in playback order. */
export interface SegmentWriter {
  readonly label: Segment;
  push(pcm: Buffer): void;
  /** No more audio for this segment. Idempotent. */
  end(): void;
  readonly hasAudio: boolean;
}

/**
 * Serializes segments so audio never interleaves: a segment's audio is held back until every earlier
 * segment has ended. `audio.segment start` goes out right before a segment's first bytes and `end`
 * right after its last; a segment that never gets audio sends nothing (so the Session doesn't wait
 * for an `audio.played` that can't come).
 */
export class SegmentOutput {
  private queue: Writer[] = [];
  constructor(private ctx: Pick<TurnContext, "turnId" | "send" | "sendAudio">) {}

  segment(label: Segment): SegmentWriter {
    const w = new Writer(label, this);
    this.queue.push(w);
    return w;
  }

  /** Labels of segments that sent audio, in order. */
  readonly sent: Segment[] = [];

  /** @internal */ isHead(w: Writer): boolean { return this.queue[0] === w; }
  /** @internal */ emit(w: Writer, pcm: Buffer): void {
    if (!w.started) {
      w.started = true;
      this.sent.push(w.label);
      this.ctx.send({ type: "audio.segment", turnId: this.ctx.turnId, segment: w.label, state: "start" });
    }
    this.ctx.sendAudio(pcm);
  }
  /** @internal */ ended(w: Writer): void {
    if (!this.isHead(w)) return;
    if (w.started) this.ctx.send({ type: "audio.segment", turnId: this.ctx.turnId, segment: w.label, state: "end" });
    this.queue.shift();
    const next = this.queue[0];
    if (next) next.drain();
  }
  /** End every open segment (turn finished or aborted). */
  endAll(): void {
    for (const w of [...this.queue]) w.end();
  }
}

class Writer implements SegmentWriter {
  started = false;
  private pending: Buffer[] = [];
  private isEnded = false;
  hasAudio = false;
  constructor(readonly label: Segment, private out: SegmentOutput) {}
  push(pcm: Buffer): void {
    if (this.isEnded || pcm.length === 0) return;
    this.hasAudio = true;
    if (this.out.isHead(this)) this.out.emit(this, pcm);
    else this.pending.push(pcm);
  }
  end(): void {
    if (this.isEnded) return;
    this.isEnded = true;
    if (this.out.isHead(this)) this.out.ended(this);
  }
  drain(): void {
    for (const b of this.pending.splice(0)) this.out.emit(this, b);
    if (this.isEnded) this.out.ended(this);
  }
}

export interface TurnBaseOpts {
  timeoutMs?: number;
  /** Called on finish/fail/cancel to snapshot usage for the RunRecord. */
  collectUsage: () => Usage;
}

/**
 * Turn lifecycle. `done` resolves exactly once: on finish() (success), fail() (adapter error or timeout:
 * sends `error {source}`) or cancel(). Every cleanup registered with onCleanup() runs once with the reason.
 */
export class TurnBase {
  readonly output: SegmentOutput;
  readonly done: Promise<TurnResult>;
  voiceText = "";
  opusText = "";
  transcript = "";
  pointing: PointingTarget[] = [];
  /** Extra meta merged into specific marks (e.g. `cold` on llm.request). */
  readonly markMeta: Partial<Record<MarkName, Record<string, unknown>>> = {};
  /** Mark function that merges `markMeta`; pass this to adapters instead of ctx.mark. */
  readonly mark: Mark;
  private finished = false;
  private resolveDone!: (r: TurnResult) => void;
  private cleanups: ((reason: CleanupReason) => void)[] = [];
  private timer: ReturnType<typeof setTimeout>;
  private errors: string[] = [];

  constructor(readonly ctx: TurnContext, private opts: TurnBaseOpts) {
    this.output = new SegmentOutput(ctx);
    this.done = new Promise((r) => (this.resolveDone = r));
    this.mark = (name, meta) => {
      const extra = this.markMeta[name];
      ctx.mark(name, extra ? { ...meta, ...extra } : meta);
    };
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.timer = setTimeout(() => this.fail("timeout", new Error(`turn exceeded ${timeoutMs} ms`)), timeoutMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  get isFinished(): boolean { return this.finished; }

  voice(delta: string): void {
    if (this.finished || !delta) return;
    this.voiceText += delta;
    this.ctx.send({ type: "voice.text", turnId: this.ctx.turnId, delta });
  }

  opus(delta: string): void {
    if (this.finished || !delta) return;
    this.opusText += delta;
    this.ctx.send({ type: "opus.text", turnId: this.ctx.turnId, delta });
  }

  sttPartial(text: string): void {
    if (!this.finished) this.ctx.send({ type: "stt.partial", turnId: this.ctx.turnId, text });
  }

  sttFinal(text: string, words: Word[]): void {
    this.transcript = text;
    if (!this.finished) this.ctx.send({ type: "stt.final", turnId: this.ctx.turnId, text, words });
  }

  /** Server-side pointing resolution (ARCHITECTURE §6): resolve, mark `pointing.resolved`, notify the client. */
  resolvePointing(words: Word[], meta: Record<string, unknown> = {}): PointingTarget[] {
    if (this.finished) return [];
    const tAudioStart = this.ctx.tAudioStart();
    const { preMs, postMs } = this.ctx.config;
    const targets = tAudioStart === undefined ? [] : resolvePointing(words, tAudioStart, this.ctx.cursorSamples(), { preMs, postMs });
    this.pointing = targets;
    this.mark("pointing.resolved", { targets: targets.length, ...(tAudioStart === undefined ? { noAudioStart: true } : {}), ...meta });
    this.ctx.send({ type: "pointing.resolved", turnId: this.ctx.turnId, targets });
    return targets;
  }

  onCleanup(fn: (reason: CleanupReason) => void): void {
    if (this.finished) { try { fn("cancel"); } catch { /* ignore */ } return; }
    this.cleanups.push(fn);
  }

  /**
   * Track a socket being opened for this turn: once it opens it is closed on cleanup; if the turn
   * already ended by then, it is closed immediately (and the returned promise rejects).
   */
  track<T extends { close(): void }>(p: Promise<T>): Promise<T> {
    return p.then((s) => {
      if (this.finished) {
        try { s.close(); } catch { /* ignore */ }
        throw new Error("turn already finished");
      }
      this.cleanups.push(() => { try { s.close(); } catch { /* ignore */ } });
      return s;
    });
  }

  /** Record a non-fatal adapter error: sends `error {source}` and sets RunRecord.error, but the turn goes on. */
  softError(source: string, err: unknown): void {
    const message = errMessage(err);
    this.errors.push(`${source}: ${message}`);
    if (!this.finished) this.ctx.send({ type: "error", turnId: this.ctx.turnId, source, message });
  }

  finish(extra: Partial<TurnResult> = {}): void {
    if (this.finished) return;
    this.output.endAll();
    this.mark("turn.end");
    this.settle("done", extra);
  }

  fail(source: string, err: unknown): void {
    if (this.finished) return;
    const message = errMessage(err);
    this.ctx.send({ type: "error", turnId: this.ctx.turnId, source, message });
    this.errors.push(`${source}: ${message}`);
    this.output.endAll();
    this.settle("error", {});
  }

  cancel(): void {
    if (this.finished) return;
    this.errors.push("cancelled");
    this.settle("cancel", {});
  }

  private settle(reason: CleanupReason, extra: Partial<TurnResult>): void {
    this.finished = true;
    clearTimeout(this.timer);
    for (const fn of this.cleanups.splice(0)) {
      try { fn(reason); } catch (e) { console.error("[orchestrator] cleanup failed", e); }
    }
    let usage: Usage = {};
    try { usage = this.opts.collectUsage(); } catch (e) { console.error("[orchestrator] usage failed", e); }
    this.resolveDone({
      transcript: this.transcript, pointing: this.pointing, voiceText: this.voiceText, opusText: this.opusText,
      usage, ...extra, ...(this.errors.length ? { error: this.errors.join("; ") } : {}),
    });
  }
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolves after `ms` (unref'd so it never keeps the process alive). */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

/** Mark wrapper for a TTS socket opened before its segment label is known: renames *.ttsFirstByte to the final label. */
export function relabelTtsMark(mark: Mark, label: () => Segment): Mark {
  return (name, meta) => {
    if (name === "ack.ttsFirstByte" || name === "answer.ttsFirstByte") {
      const l = label();
      if (isMarkedSegment(l)) mark(`${l}.ttsFirstByte`, meta); // filler/notice audio carries no mark
    } else mark(name, meta);
  };
}
