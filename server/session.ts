// One browser connection = one Session (ARCHITECTURE §1, §3).
import { randomUUID } from "node:crypto";
import type { WebSocket, RawData } from "ws";
import { parseClientMsg, type ClientMsg, type CursorSample, type PageEvents, type RunRecord, type Segment, type ServerMsg } from "../shared/protocol.ts";
import { deriveMetrics, type MarkName } from "../shared/marks.ts";
import type { RunConfig } from "../shared/config.ts";
import { serverToClient } from "../shared/clock.ts";
import { serverNow, type Mark } from "./clock.ts";
import type { Orchestrator, TurnHandlers, TurnResult } from "./orchestrators/types.ts";
import { realtimeOrchestrator } from "./orchestrators/realtime.ts";
import { pipelineOrchestrator } from "./orchestrators/pipeline.ts";
import { hybridOrchestrator } from "./orchestrators/hybrid.ts";
import { cursorOnlyOrchestrator } from "./orchestrators/cursorOnly.ts";
import { appendRun } from "./results.ts";
import { computeCost } from "./cost.ts";
import { ConnectionState } from "./connection.ts";
import { getConversation, resetConversation } from "./conversation.ts";
import { dropRealtime } from "./orchestrators/shared.ts";
import { cancelJobs } from "./orchestrators/jobs.ts";
import type { ConnectionChannel } from "./orchestrators/types.ts";
import { isMarkedSegment } from "../shared/marks.ts";

export const ORCHESTRATORS: Partial<Record<RunConfig["approach"], Orchestrator>> = {
  realtime: realtimeOrchestrator,
  pipeline: pipelineOrchestrator,
  hybrid: hybridOrchestrator,
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
  segmentsSent: Set<Segment>;
  page: PageEvents;
  segmentsPlayed: Set<Segment>;
  onPlayed?: () => void;
  handlers?: TurnHandlers;
}

export interface SessionOpts {
  orchestrators?: Partial<Record<RunConfig["approach"], Orchestrator>>;
  persist?: boolean;
}

export class Session {
  private turn: Turn | null = null;
  private clock = { rttMs: 0, offsetMs: 0 };
  private echo = false;
  /** Per-connection state that outlives turns (e.g. the reused Realtime session). */
  private connection = new ConnectionState();

  private orchestrators: Partial<Record<RunConfig["approach"], Orchestrator>>;
  private persist: boolean;
  private idleWaiters: (() => void)[] = [];
  private noticeAbort: (() => void) | null = null;

  /** Connection-level output for background jobs (orchestrators/jobs.ts). */
  private channel: ConnectionChannel = {
    send: (m) => this.send(m),
    sendAudio: (pcm) => this.sendAudio(pcm),
    isIdle: () => this.turn === null,
    whenIdle: () => new Promise<void>((resolve) => {
      const check = () => {
        if (this.turn) return void this.idleWaiters.push(check);
        // Stay quiet for a moment after a turn, and re-check in case a new one started meanwhile.
        setTimeout(() => (this.turn ? this.idleWaiters.push(check) : resolve()), IDLE_GRACE_MS);
      };
      check();
    }),
    setNoticeAbort: (abort) => { this.noticeAbort = abort; },
  };

  private clearTurn(): void {
    this.turn = null;
    for (const w of this.idleWaiters.splice(0)) w();
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
    ws.on("close", () => {
      this.turn?.handlers?.cancel();
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
        return this.startTurn(msg.turnId, msg.config, msg.tPress, msg.fixtureId);
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
        return;
      case "conversation.reset":
        this.turn?.handlers?.cancel();
        this.clearTurn();
        this.stopNotice();
        cancelJobs(this.connection);
        resetConversation(this.connection);
        dropRealtime(this.connection);
        return;
    }
  }

  private startTurn(turnId: string, config: RunConfig, tPress: number, fixtureId?: string): void {
    this.turn?.handlers?.cancel();
    const turn: Turn = {
      turnId, config, fixtureId, marks: { press: tPress }, markMeta: {}, samples: [], released: false,
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
      return;
    }
    try {
      turn.handlers = orchestrator({
        turnId, config, mark,
        send: (m) => {
          if (this.turn !== turn) return;
          if (m.type === "audio.segment" && m.state === "start") turn.segmentsSent.add(m.segment);
          this.send(m);
        },
        sendAudio: (pcm) => this.turn === turn && this.sendAudio(pcm),
        cursorSamples: () => turn.samples,
        tAudioStart: () => turn.tAudioStart,
        pageEvents: () => turn.page,
        connection: this.connection,
        channel: this.channel,
      });
    } catch (e) {
      this.send({ type: "error", turnId, source: "orchestrator", message: String(e) });
      this.clearTurn();
      return;
    }
    turn.handlers.done
      .catch((e): TurnResult => ({ transcript: "", pointing: [], voiceText: "", opusText: "", usage: {}, error: String(e) }))
      .then((result) => this.finishTurn(turn, result));
  }

  private async finishTurn(turn: Turn, result: TurnResult): Promise<void> {
    if (this.turn !== turn) return;
    // Chat mode: record the turn right away, so a quick follow-up already sees it.
    if (turn.config.memory && (result.transcript || result.voiceText)) {
      getConversation(this.connection).push({
        turnId: turn.turnId, approach: turn.config.approach,
        user: result.transcript, assistant: result.voiceText.trim(), detail: result.opusText,
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
    if (result.ackIsAnswer) relabelAckAsAnswer(turn);
    const usage = result.usage;
    const run: RunRecord = {
      runId: randomUUID(), turnId: turn.turnId, approach: turn.config.approach, config: turn.config,
      fixtureId: turn.fixtureId, marks: turn.marks, metrics: deriveMetrics(turn.marks),
      transcript: result.transcript, pointing: result.pointing, voiceText: result.voiceText, opusText: result.opusText,
      usage, costUsd: computeCost(turn.config, usage), clock: this.clock, markMeta: turn.markMeta, error: result.error,
    };
    this.send({ type: "turn.done", turnId: turn.turnId, run });
    this.clearTurn();
    if (this.persist) appendRun(run).catch((e) => console.error("[results] append failed", e));
  }
}

/** Realtime/hybrid turn with no ask_opus call: the "ack" audio was the answer (see TurnResult.ackIsAnswer). */
function relabelAckAsAnswer(turn: Turn): void {
  const pairs = [["ack.ttsFirstByte", "answer.ttsFirstByte"], ["ack.played", "answer.played"]] as const;
  for (const [from, to] of pairs) {
    if (turn.marks[from] === undefined || turn.marks[to] !== undefined) continue;
    turn.marks[to] = turn.marks[from];
    turn.markMeta[to] = { ...turn.markMeta[from], relabeledFrom: from };
    delete turn.marks[from];
    delete turn.markMeta[from];
  }
}
