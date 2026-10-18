// Element threads: the speaking floor of one connection (docs/PLAN-threads.md, "Speaking floor"). Lines spoken
// outside a turn (thread results, reminders, central lines) wait in a queue and play one at a time, only while
// no turn is active and after a short quiet period. A turn starting stops the current line: a line that hadn't
// made a sound yet is queued again; one that had is dropped (an interrupted reminder isn't replayed, an
// interrupted result stays unread on its thread). Priority: the focused thread's result > other results >
// central lines > reminders; reminders that are ready together are batched into one line.
//
// Each line is framed with `thread.say {state: start|end}`; its audio goes out between them (segment "notice").
// Voice: the turn's TTS (the same path as a background job's spoken result).
import { randomUUID } from "node:crypto";
import type { RunConfig } from "../../shared/config.ts";
import type { CostItem, ServerMsg } from "../../shared/protocol.ts";
import type { ThreadSay } from "../../shared/threads.ts";
import type { OrchestratorDeps } from "../orchestrators/types.ts";
import { spokenCostItem } from "../orchestrators/jobs.ts";
import { linePriority, reminderText } from "./policy.ts";

/** Speaks one line; `done` resolves with what it cost once the audio is out (or the speaker was stopped). */
export type Speaker = (text: string, onAudio: (pcm: Buffer) => void) => { stop(): void; done: Promise<CostItem | null> };

export type LineOutcome = "spoken" | "interrupted";

export interface FloorLine {
  say: ThreadSay;
  kind: "result" | "reminder" | "central";
  /** Reminders: the thread's title (for batching) and language. */
  title?: string;
  language?: string;
  speaker: Speaker;
  /** Checked right before speaking: false drops the line (thread deleted, result already told). */
  valid?: () => boolean;
  onDone?: (outcome: LineOutcome, cost: CostItem | null) => void;
}

export interface FloorIo {
  send(msg: ServerMsg): void;
  sendAudio(pcm: Buffer): void;
}

export interface FloorOpts {
  /** Quiet period after a turn before a line may start (ms). */
  graceMs?: number;
  /** The focused thread (for priority). */
  focused?: () => string | null;
  /** Something else is speaking outside a turn (a background job's notice): wait. */
  busy?: () => boolean;
  /** The floor went quiet (nothing playing). */
  onIdle?: () => void;
}

const noMark = () => {};

/** The turn's TTS as a Speaker (like jobs.ts speakOnce). No voice configured, or config.silent: silent. */
export function ttsSpeaker(deps: Pick<OrchestratorDeps, "openTts" | "voiceId">, config: RunConfig, language?: string): Speaker {
  // A silent run (a typed comment's): the line is only shown, never spoken.
  if (config.silent) return () => ({ stop: () => {}, done: Promise.resolve(null) });
  return (text, onAudio) => {
    let stopped = false;
    let close: (() => void) | null = null;
    const done = (async (): Promise<CostItem | null> => {
      const voiceId = deps.voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? "";
      if (!voiceId && config.ttsModel.startsWith("eleven_")) return null;
      const tts = await deps.openTts({ mark: noMark, voiceId, model: config.ttsModel, segment: "answer", language, style: config.ttsStyle, ...(config.ttsVoice ? { voice: config.ttsVoice } : {}) });
      if (stopped) { tts.close(); return null; }
      close = () => tts.close();
      tts.onAudio((pcm) => { if (!stopped) onAudio(pcm); });
      tts.pushText(text);
      tts.flush();
      await tts.done().catch(() => {});
      return tts.chars ? spokenCostItem(config, tts.chars) : null;
    })();
    return { stop: () => { stopped = true; close?.(); }, done };
  };
}

interface Playing { line: FloorLine; members: FloorLine[]; started: boolean; stop: () => void; cut: "turn" | "stop" | null }

export class Floor {
  private queue: FloorLine[] = [];
  private playing: Playing | null = null;
  private turnActive = false;
  private quietUntil = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly graceMs: number;

  constructor(private io: FloorIo, private opts: FloorOpts = {}) {
    this.graceMs = opts.graceMs ?? 800;
  }

  /** A line is playing (or about to). */
  get speaking(): boolean { return this.playing !== null; }
  get queued(): readonly FloorLine[] { return this.queue; }

  enqueue(line: FloorLine): void {
    if (this.closed) return;
    this.queue.push(line);
    this.pump();
  }

  /** A turn started: the user has the floor. The current line stops. */
  turnStarted(): void {
    this.turnActive = true;
    this.cut("turn");
  }

  /** The turn is over: lines may play again after the quiet period. */
  turnEnded(): void {
    this.turnActive = false;
    this.quietUntil = Date.now() + this.graceMs;
    this.pump();
  }

  /** The user stopped speech (Esc): the current line is dropped, the queue stays. */
  stop(): void { this.cut("stop"); }

  /** Something else that held the floor (a job notice) finished. */
  kick(): void { this.pump(); }

  /** Drop a thread's lines (deleted, or its result was read in the panel). */
  drop(threadId: string): void {
    this.queue = this.queue.filter((l) => l.say.threadId !== threadId);
    const p = this.playing;
    if (p && p.members.some((l) => l.say.threadId === threadId)) this.cut("stop");
  }

  clear(): void {
    this.queue = [];
    this.cut("stop");
  }

  close(): void {
    this.closed = true;
    this.clear();
    if (this.timer) clearTimeout(this.timer);
  }

  private cut(reason: "turn" | "stop"): void {
    const p = this.playing;
    if (!p || p.cut) return;
    p.cut = reason;
    p.stop();
  }

  private pump(): void {
    if (this.closed || this.playing || this.turnActive || !this.queue.length || this.timer) return;
    if (this.opts.busy?.()) return;
    const wait = this.quietUntil - Date.now();
    if (wait > 0) {
      this.timer = setTimeout(() => { this.timer = null; this.pump(); }, wait);
      (this.timer as { unref?: () => void }).unref?.();
      return;
    }
    this.queue = this.queue.filter((l) => l.valid?.() ?? true);
    const next = this.pick();
    if (next) this.play(next.line, next.members);
  }

  /** The highest-priority line; a reminder takes every queued reminder with it (one batched line). */
  private pick(): { line: FloorLine; members: FloorLine[] } | null {
    if (!this.queue.length) return null;
    const focused = this.opts.focused?.() ?? null;
    const prio = (l: FloorLine) => linePriority(l.kind, l.say.threadId !== null && l.say.threadId === focused);
    let best = this.queue[0]!;
    for (const l of this.queue) if (prio(l) > prio(best)) best = l;
    if (best.kind !== "reminder") {
      this.queue.splice(this.queue.indexOf(best), 1);
      return { line: best, members: [best] };
    }
    const members = this.queue.filter((l) => l.kind === "reminder");
    this.queue = this.queue.filter((l) => l.kind !== "reminder");
    if (members.length === 1) return { line: best, members };
    const titles = members.map((m) => m.title ?? "an element");
    const threads = new Set(members.map((m) => m.say.threadId));
    const line: FloorLine = {
      ...best,
      say: { sayId: randomUUID(), threadId: threads.size === 1 ? best.say.threadId : null, text: reminderText(titles, best.language), needsReply: false },
    };
    return { line, members };
  }

  private play(line: FloorLine, members: FloorLine[]): void {
    const p: Playing = { line, members, started: false, stop: () => {}, cut: null };
    this.playing = p;
    const start = () => {
      if (p.started) return;
      p.started = true;
      this.io.send({ type: "thread.say", say: line.say, state: "start" });
    };
    const sp = line.speaker(line.say.text, (pcm) => {
      if (p.cut) return;
      start();
      this.io.sendAudio(pcm);
    });
    p.stop = sp.stop;
    void sp.done.catch((e): CostItem | null => { console.warn("[floor] speak failed", e); return null; }).then((cost) => {
      if (this.playing === p) this.playing = null;
      // Spoke nothing and wasn't cut (no voice configured, or a TTS error): still show the line.
      if (!p.cut) start();
      if (p.started) this.io.send({ type: "thread.say", say: line.say, state: "end" });
      if (p.cut === "turn" && !p.started) {
        this.queue.unshift(...members); // pre-empted before any audio: try again later
      } else {
        const outcome: LineOutcome = p.cut ? "interrupted" : "spoken";
        members.forEach((m, i) => m.onDone?.(outcome, i === 0 ? cost : null));
      }
      this.opts.onIdle?.();
      this.pump();
    });
  }
}
