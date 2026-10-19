import { isMarkedSegment } from "../../shared/marks.ts";
// Shared per-turn plumbing for the orchestrators: ordered audio segments, text accumulation,
// socket cleanup, the overall turn timeout and "finish exactly once" semantics.
import type { MarkName } from "../../shared/marks.ts";
import { browserUrl } from "../browserPage.ts";
import { formatElementDetails, referencedElements } from "../../shared/elementDetails.ts";
import { annotateTranscript, computeRests, detectLanguage, formatPageContext, formatRests, languagesFor, normalizeLanguage, resolvePointing } from "../../shared/pointing.ts";
import type { CursorRest, PointingTarget, Segment, Usage, Word } from "../../shared/protocol.ts";
import type { Mark } from "../clock.ts";
import type { TurnContext, TurnResult } from "./types.ts";

export const DEFAULT_TURN_TIMEOUT_MS = 60_000;
/** PCM16 mono 24 kHz. */
const BYTES_PER_MS = 48;
/** A segment with less than this left to play isn't cut off: it ends on its own (SegmentOutput.cut). */
export const CUT_TAIL_MS = 350;

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

  /**
   * Estimated time (performance.now() ms) the client finishes playing the audio sent so far: playback is
   * gapless and starts when audio arrives, so each chunk extends max(playEnd, now) by its duration.
   */
  playEnd = 0;

  /** True when every segment created so far has ended (nothing queued or open). */
  get idle(): boolean { return this.queue.length === 0; }

  /** @internal */ isHead(w: Writer): boolean { return this.queue[0] === w; }
  /** @internal */ emit(w: Writer, pcm: Buffer): void {
    if (!w.started) {
      w.started = true;
      this.sent.push(w.label);
      this.ctx.send({ type: "audio.segment", turnId: this.ctx.turnId, segment: w.label, state: "start" });
    }
    this.playEnd = Math.max(this.playEnd, performance.now()) + pcm.length / BYTES_PER_MS;
    w.playEnd = this.playEnd;
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

  /**
   * Cut a segment off: what it hasn't sent yet is dropped, and if the user is hearing it (some of it went out and
   * more than CUT_TAIL_MS of it is left to play, or it's still coming in) the client is told to stop playing it
   * (`audio.cut`). Returns whether it was cut off audibly. One that never started is just dropped; one that's about
   * to end is left to end.
   */
  cut(w: SegmentWriter): boolean {
    const writer = w as Writer;
    const now = performance.now();
    const heard = writer.started && (!writer.isEnded || writer.playEnd - now > CUT_TAIL_MS);
    if (writer.started && !heard) return false;
    if (heard) {
      this.ctx.send({ type: "audio.cut", turnId: this.ctx.turnId, segment: writer.label });
      // Nothing after it was sent yet (later segments wait for it to end): the client is quiet from now.
      this.playEnd = now;
    }
    writer.drop();
    return heard;
  }
}

class Writer implements SegmentWriter {
  started = false;
  /** When its audio sent so far finishes playing (SegmentOutput.playEnd after its last chunk). */
  playEnd = 0;
  private pending: Buffer[] = [];
  isEnded = false;
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
  /** Cut off: drop what wasn't sent, and end it (the next segment goes on). */
  drop(): void {
    this.pending = [];
    this.end();
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
  solverText = "";
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

  /** `line`: the delta starts a new spoken line (see the voice.text message). */
  voice(delta: string, line = false): void {
    if (this.finished || !delta) return;
    this.voiceText += delta;
    this.ctx.send({ type: "voice.text", turnId: this.ctx.turnId, delta, ...(line ? { line: true as const } : {}) });
  }

  solver(delta: string): void {
    if (this.finished || !delta) return;
    this.solverText += delta;
    this.ctx.send({ type: "solver.text", turnId: this.ctx.turnId, delta });
  }

  sttPartial(text: string): void {
    if (!this.finished) this.ctx.send({ type: "stt.partial", turnId: this.ctx.turnId, text });
  }

  /** Words of the final transcript (for aligning clicks). */
  words: Word[] = [];

  /** Detected spoken language ("en", "ro", …), or the pinned one; undefined until known. */
  language: string | undefined = undefined;
  /** Where the cursor rested while the user spoke (language-agnostic pointing hints). */
  rests: CursorRest[] = [];

  sttFinal(text: string, words: Word[], detected?: string): void {
    this.transcript = text;
    this.words = words;
    // Pinned setting, else Scribe's code (null in auto mode so far), else a guess from the text.
    const pinned = this.ctx.config.language;
    this.language = (pinned && pinned !== "auto" ? pinned : undefined) ?? normalizeLanguage(detected) ?? detectLanguage(text);
    if (this.language) this.ctx.connection.set("language", this.language);
    if (!this.finished) {
      this.ctx.send({ type: "stt.final", turnId: this.ctx.turnId, text, words, ...(this.language ? { language: this.language } : {}) });
    }
  }

  /** The transcript with pointing [n] and cursor-rest [@n] markers, or the plain transcript. */
  markedTranscript(): string {
    return annotateTranscript(this.words, this.pointing, this.rests) ?? this.transcript;
  }

  /** Server-side pointing resolution (ARCHITECTURE §6): resolve, mark `pointing.resolved`, notify the client. */
  resolvePointing(words: Word[], meta: Record<string, unknown> = {}): PointingTarget[] {
    if (this.finished) return [];
    const tAudioStart = this.ctx.tAudioStart();
    const { preMs, postMs } = this.ctx.config;
    const samples = this.ctx.cursorSamples();
    const targets = tAudioStart === undefined ? [] : resolvePointing(words, tAudioStart, samples, { preMs, postMs }, languagesFor(this.ctx.config.language));
    this.pointing = targets;
    this.rests = computeRests(words, tAudioStart, samples, targets);
    this.mark("pointing.resolved", { targets: targets.length, rests: this.rests.length, ...(tAudioStart === undefined ? { noAudioStart: true } : {}), ...meta });
    this.ctx.send({ type: "pointing.resolved", turnId: this.ctx.turnId, targets, rests: this.rests });
    return targets;
  }

  /**
   * Extra page context as LLM lines ("" if none): the browser's URL, where the cursor rested (@n), clicks and
   * highlighted text, then the design details of the elements referenced ([n], [@n]): one compact line each, or
   * everything (selector, DOM path, bounds, computed styles, HTML) with `elements: "full"` (the solver).
   * Call after resolvePointing for word alignment.
   */
  pageContext(words: Word[] = this.words, opts: { elements?: "compact" | "full" } = {}): string {
    const tAudioStart = this.ctx.tAudioStart();
    const ev = this.ctx.pageEvents?.();
    const page = this.ctx.pageUrl?.() ?? browserUrl();
    const lines = [page ? `Browser: the user is on ${JSON.stringify(page)} (the page to the left of the chat).` : "", formatRests(this.rests, words, tAudioStart)];
    if (ev && (ev.clicks.length || ev.preselected || ev.highlights.length)) lines.push(formatPageContext(ev, words, tAudioStart, this.pointing));
    lines.push(formatElementDetails(referencedElements(this.pointing, this.rests, this.ctx.cursorSamples()), opts.elements === "full"));
    return lines.filter(Boolean).join("\n");
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
      transcript: this.transcript, pointing: this.pointing, voiceText: this.voiceText, solverText: this.solverText,
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
