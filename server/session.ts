// One browser connection = one Session (ARCHITECTURE §1, §3).
import { randomUUID } from "node:crypto";
import type { WebSocket, RawData } from "ws";
import { parseClientMsg, type ClientMsg, type CostItem, type CursorSample, type PageEvents, type RunRecord, type Segment, type ServerMsg } from "../shared/protocol.ts";
import { deriveMetrics, type MarkName } from "../shared/marks.ts";
import { llmOf, type RunConfig } from "../shared/config.ts";
import { serverToClient } from "../shared/clock.ts";
import { serverNow, type Mark } from "./clock.ts";
import type { Orchestrator, TurnHandlers, TurnResult } from "./orchestrators/types.ts";
import { pipelineOrchestrator } from "./orchestrators/pipeline.ts";
import { cursorOnlyOrchestrator } from "./orchestrators/cursorOnly.ts";
import { appendRun } from "./results.ts";
import { computeCost, costItems } from "./cost.ts";
import { ConnectionState } from "./connection.ts";
import { getConversation } from "./conversation.ts";
import { cancelJobs } from "./orchestrators/jobs.ts";
import type { ConnectionChannel } from "./orchestrators/types.ts";
import { isMarkedSegment } from "../shared/marks.ts";
import { Floor } from "./threads/floor.ts";
import { threadStore, type ThreadSubscriber } from "./threads/store.ts";

export const ORCHESTRATORS: Partial<Record<RunConfig["approach"], Orchestrator>> = {
  pipeline: pipelineOrchestrator,
  "cursor-only": cursorOnlyOrchestrator,
};

/** How long to wait after the orchestrator finishes for audio.played reports. */
const PLAYED_GRACE_MS = 3000;
/** After a turn ends, how long the connection must stay quiet before a background notice may speak. */
const IDLE_GRACE_MS = 800;

interface Turn {
  turnId: string;
  config: RunConfig;
  fixtureId?: string;
  marks: Partial<Record<MarkName, number>>;
  markMeta: Partial<Record<MarkName, Record<string, unknown>>>;
  samples: CursorSample[];
  tAudioStart?: number;
  released: boolean;
  /** Always-listen ended the turn. Set on turn.release, read by the orchestrator. */
  auto: boolean;
  segmentsSent: Set<Segment>;
  page: PageEvents;
  segmentsPlayed: Set<Segment>;
  onPlayed?: () => void;
  handlers?: TurnHandlers;
  /** Element threads: the thread this turn was routed to (from its decision); its cost is credited there too. */
  threadId?: string;
}

export interface SessionOpts {
  orchestrators?: Partial<Record<RunConfig["approach"], Orchestrator>>;
  persist?: boolean;
}

export class Session {
  private turn: Turn | null = null;
  private clock = { rttMs: 0, offsetMs: 0 };
  private echo = false;
  /** Per-connection state that outlives turns (e.g. background jobs). */
  private connection = new ConnectionState();

  private orchestrators: Partial<Record<RunConfig["approach"], Orchestrator>>;
  private persist: boolean;
  private idleWaiters: (() => void)[] = [];
  private noticeAbort: (() => void) | null = null;

  /**
   * Element threads: the speaking floor for lines outside a turn (thread results, reminders). It waits for the
   * turn and for a background job's notice; a job's notice waits for it in turn (channel.whenIdle / isIdle).
   */
  private floor: Floor = new Floor(
    { send: (m) => this.send(m), sendAudio: (pcm) => this.sendAudio(pcm) },
    { graceMs: IDLE_GRACE_MS, focused: () => threadStore().focused(), busy: () => this.noticeAbort !== null, onIdle: () => this.wakeIdle() },
  );
  private threadSub: ThreadSubscriber = { send: (m) => this.send(m), floor: this.floor };
  private unsubscribe: () => void;

  /** Connection-level output for background jobs (orchestrators/jobs.ts). */
  private channel: ConnectionChannel = {
    send: (m) => this.send(m),
    sendAudio: (pcm) => this.sendAudio(pcm),
    isIdle: () => this.turn === null && !this.floor.speaking,
    whenIdle: () => new Promise<void>((resolve) => {
      const busy = () => this.turn !== null || this.floor.speaking;
      const check = () => {
        if (busy()) return void this.idleWaiters.push(check);
        // Stay quiet for a moment after a turn, and re-check in case a new one started meanwhile.
        setTimeout(() => (busy() ? this.idleWaiters.push(check) : resolve()), IDLE_GRACE_MS);
      };
      check();
    }),
    setNoticeAbort: (abort) => {
      this.noticeAbort = abort;
      if (!abort) this.floor.kick(); // the job's notice is over: thread lines may speak
    },
  };

  private wakeIdle(): void {
    for (const w of this.idleWaiters.splice(0)) w();
  }

  private clearTurn(): void {
    const had = this.turn !== null;
    this.turn = null;
    if (had) this.floor.turnEnded();
    this.wakeIdle();
  }

  private stopNotice(): void {
    const abort = this.noticeAbort;
    this.noticeAbort = null;
    abort?.();
  }

  /**
   * `orchestrators` overrides the routing table and `persist: false` skips appending runs to results/
   * (both used by `smoke:e2e --fake`).
   */
  constructor(private ws: WebSocket, opts: SessionOpts = {}) {
    this.orchestrators = opts.orchestrators ?? ORCHESTRATORS;
    this.persist = opts.persist ?? true;
    ws.on("message", (data, isBinary) => (isBinary ? this.onBinary(data) : this.onText(data.toString())));
    // Element threads: the snapshot now, every change after (threads outlive this connection).
    this.unsubscribe = threadStore().subscribe(this.threadSub);
    ws.on("close", () => {
      this.turn?.handlers?.cancel();
      this.unsubscribe();
      this.floor.close();
      this.connection.disposeAll();
    });
  }

  send(msg: ServerMsg): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private sendAudio(pcm: Buffer): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(pcm, { binary: true });
  }

  private onBinary(data: RawData): void {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (!this.turn) {
      if (this.echo) this.sendAudio(buf);
      return;
    }
    if (this.turn.released) return; // audio after release is ignored
    this.turn.handlers?.onAudio(buf);
  }

  private onText(raw: string): void {
    const msg = parseClientMsg(raw);
    if (!msg) return this.send({ type: "error", source: "session", message: "bad message" });
    this.handle(msg);
  }

  private handle(msg: ClientMsg): void {
    switch (msg.type) {
      case "hello":
        console.log("[session] hello");
        return;
      case "ping":
        return this.send({ type: "pong", id: msg.id, clientNow: msg.clientNow, serverNow: serverNow() });
      case "clock.sync":
        this.clock = { rttMs: msg.rttMs, offsetMs: msg.offsetMs };
        return;
      case "echo":
        this.echo = msg.on;
        return;
      case "turn.start":
        this.stopNotice(); // the user talks over a background notice: stop it
        this.floor.turnStarted(); // …or over a thread's line
        threadStore().touch(this.threadSub); // this connection speaks thread results from now on
        return this.startTurn(msg.turnId, msg.config, msg.tPress, msg.fixtureId, typeof msg.pageUrl === "string" ? msg.pageUrl : undefined,
          typeof msg.text === "string" && msg.text.trim() ? msg.text : undefined);
      case "cursor.samples":
        if (this.turn?.turnId === msg.turnId) this.turn.samples.push(...msg.samples);
        return;
      case "turn.context":
        if (this.turn?.turnId === msg.turnId) {
          this.turn.page = {
            clicks: (msg.clicks ?? []).slice(-20),
            preselected: msg.preselected ?? null,
            highlights: (msg.highlights ?? []).slice(-12),
          };
        }
        return;
      case "turn.audioStart":
        if (this.turn?.turnId === msg.turnId) this.turn.tAudioStart = msg.tAudioStart;
        return;
      case "turn.release":
        if (this.turn?.turnId !== msg.turnId || this.turn.released) return;
        this.turn.released = true;
        this.turn.auto = msg.auto === true;
        this.turn.marks.release = msg.tRelease;
        this.turn.handlers?.onRelease();
        return;
      case "audio.played": {
        const t = this.turn;
        if (t?.turnId !== msg.turnId) return;
        if (isMarkedSegment(msg.segment)) t.marks[`${msg.segment}.played`] ??= msg.tPlayed;
        t.segmentsPlayed.add(msg.segment);
        t.onPlayed?.();
        return;
      }
      case "turn.cancel": {
        const t = this.turn;
        if (t?.turnId !== msg.turnId) return;
        const h = t.handlers;
        this.clearTurn();
        h?.cancel();
        // Chat mode: keep what was said so far, so "no, I meant…" makes sense next turn.
        if (msg.reason && t.config.memory && h) {
          void h.done.then((r) => {
            if (!r.transcript && !r.voiceText) return;
            getConversation(this.connection).push({
              turnId: t.turnId, approach: t.config.approach, user: r.transcript,
              assistant: `${r.voiceText.trim()} [${msg.reason === "interrupt" ? "interrupted" : "stopped"} by the user]`.trim(),
              detail: "",
            });
          }, () => {});
        }
        return;
      }
      case "speech.stop":
        this.stopNotice();
        this.floor.stop();
        return;
      case "conversation.reset":
        this.turn?.handlers?.cancel();
        this.clearTurn();
        this.stopNotice();
        cancelJobs(this.connection);
        threadStore().reset(); // every thread (runs stopped) and the central conversation
        return;
      case "thread.delete":
        threadStore().remove(msg.threadId);
        return;
      case "thread.focus":
        threadStore().focus(msg.threadId);
        return;
    }
  }

  private startTurn(turnId: string, sent: RunConfig, tPress: number, fixtureId?: string, pageUrl?: string, typedText?: string): void {
    this.turn?.handlers?.cancel();
    // Older clients send `claudeBackend` instead of `llm`.
    const config: RunConfig = { ...sent, llm: llmOf(sent) };
    const turn: Turn = {
      turnId, config, fixtureId, marks: { press: tPress }, markMeta: {}, samples: [], released: false, auto: false,
      segmentsSent: new Set(), segmentsPlayed: new Set(), page: { clicks: [], preselected: null, highlights: [] },
    };
    this.turn = turn;

    const mark: Mark = (name, meta) => {
      if (this.turn !== turn) return;
      const now = serverNow();
      if (turn.marks[name] === undefined) {
        turn.marks[name] = serverToClient(now, this.clock.offsetMs);
        if (meta) turn.markMeta[name] = meta;
      }
      this.send({ type: "mark", turnId, name, serverNow: now, meta });
    };

    const orchestrator = this.orchestrators[config.approach];
    if (!orchestrator) {
      this.send({ type: "error", turnId, source: "session", message: `no orchestrator for ${config.approach}` });
      this.clearTurn();
      return;
    }
    try {
      turn.handlers = orchestrator({
        turnId, config, mark,
        send: (m) => {
          if (this.turn !== turn) return;
          if (m.type === "audio.segment" && m.state === "start") turn.segmentsSent.add(m.segment);
          if (m.type === "decision" && m.threadId) turn.threadId = m.threadId;
          this.send(m);
        },
        sendAudio: (pcm) => this.turn === turn && this.sendAudio(pcm),
        cursorSamples: () => turn.samples,
        tAudioStart: () => turn.tAudioStart,
        ...(pageUrl ? { pageUrl: () => pageUrl } : {}),
        ...(typedText ? { typedText } : {}),
        pageEvents: () => turn.page,
        connection: this.connection,
        channel: this.channel,
        autoEndpoint: () => turn.auto,
      });
    } catch (e) {
      this.send({ type: "error", turnId, source: "orchestrator", message: String(e) });
      this.clearTurn();
      return;
    }
    turn.handlers.done
      .catch((e): TurnResult => ({ transcript: "", pointing: [], voiceText: "", solverText: "", usage: {}, error: String(e) }))
      .then((result) => this.finishTurn(turn, result));
  }

  private async finishTurn(turn: Turn, result: TurnResult): Promise<void> {
    if (this.turn !== turn) return;
    // Chat mode: record the turn right away, so a quick follow-up already sees it.
    if (turn.config.memory && (result.transcript || result.voiceText)) {
      getConversation(this.connection).push({
        turnId: turn.turnId, approach: turn.config.approach,
        user: result.transcript, assistant: result.voiceText.trim(), detail: result.solverText,
      });
    }
    // Wait for the client to report every segment we sent as played.
    await new Promise<void>((resolve) => {
      const check = () => [...turn.segmentsSent].every((s) => turn.segmentsPlayed.has(s)) && resolve();
      turn.onPlayed = check;
      check();
      setTimeout(resolve, PLAYED_GRACE_MS);
    });
    if (this.turn !== turn) return;
    const usage = result.usage;
    const run: RunRecord = {
      runId: randomUUID(), turnId: turn.turnId, approach: turn.config.approach, config: turn.config,
      fixtureId: turn.fixtureId, marks: turn.marks, metrics: deriveMetrics(turn.marks),
      transcript: result.transcript, pointing: result.pointing, voiceText: result.voiceText, solverText: result.solverText,
      usage, costUsd: computeCost(turn.config, usage), costItems: costItems(turn.config, usage),
      clock: this.clock, markMeta: turn.markMeta, error: result.error,
    };
    this.send({ type: "turn.done", turnId: turn.turnId, run });
    if (turn.threadId && run.costItems?.length) creditThread(turn.threadId, turn.turnId, run.costItems);
    this.clearTurn();
    if (this.persist) appendRun(run).catch((e) => console.error("[results] append failed", e));
  }
}

/** A thread's cost includes the turns routed to it (the router, voice, speech), not only its runs outside a turn. */
function creditThread(threadId: string, turnId: string, items: CostItem[]): void {
  threadStore().update(threadId, (t) => {
    t.costItems = [...(t.costItems ?? []), ...items.map((i) => ({ ...i, turnId }))];
    t.costUsd = (t.costUsd ?? 0) + items.reduce((n, i) => n + i.usd, 0);
  });
}
