// Approach A (realtime) and the shared core of approach C (hybrid). ARCHITECTURE §7, PRD §4.
//
// A: audio → the connection's reused OpenAI Realtime session → release → commitAndRespond(). The
//    model speaks a short ack and calls ask_opus → solveWithOpus → as soon as the SPOKEN line is ready,
//    sendToolResult(callId, spokenLine + note) → the model speaks the answer. Opus keeps streaming
//    opus.text until it finishes.
// C: as A, plus the audio is teed to a per-turn Scribe stream. On release both are committed; we wait
//    up to hybridWaitMs for Scribe's final, resolve pointing, and inject it as a context item.
//
// Segment labels: the first response of the turn is "ack" on the wire (the adapter's currentSegment),
// the post-tool response is "answer". If the turn ends without an ask_opus call, the first response
// WAS the answer, so the TurnResult sets `ackIsAnswer` and the Session renames the marks (PRD §7: TTA = TTFA).
import { formatPointingContext } from "../../shared/pointing.ts";
import type { Segment } from "../../shared/protocol.ts";
import type { RealtimeSession, ToolCall } from "../adapters/types.ts";
import { realDeps } from "./deps.ts";
import { acquireRealtime, LazyScribe, type RealtimeLease, type RealtimeListener } from "./shared.ts";
import { errMessage, sleep, TurnBase, type SegmentWriter } from "./turnBase.ts";
import type { Orchestrator, OrchestratorDeps } from "./types.ts";

/** Appended to the spoken line in the tool result; the model is told to speak only the first paragraph. */
export const TOOL_RESULT_NOTE = "(The detailed answer is being shown on the user's screen. Speak only the paragraph above.)";
/** Max model responses per turn (ack, answer, and a couple of stray tool rounds). */
const MAX_RESPONSES = 4;

class Tagged extends Error {
  constructor(readonly source: string, cause: unknown) { super(errMessage(cause)); }
}
const tag = <T>(source: string, p: Promise<T>): Promise<T> => p.catch((e) => { throw e instanceof Tagged ? e : new Tagged(source, e); });

export function createRealtimeLikeOrchestrator(deps: OrchestratorDeps, hybrid: boolean): Orchestrator {
  return (ctx) => {
    const cfg = ctx.config;
    const warm = cfg.prewarm;
    let lease: RealtimeLease | null = null;
    let session: RealtimeSession | null = null;
    let leaseP: Promise<RealtimeLease> | null = null;
    const audioBuf: Buffer[] = [];
    let responding = false;
    let responsesDone = false;
    let toolSeen = false;
    let pendingTool: Promise<void> | null = null;
    const opusRuns: Promise<void>[] = [];
    let opusUsage: unknown = undefined;
    let writer: SegmentWriter | null = null;
    let textSeg: Segment = "ack";
    // hybrid
    let finalArrived = false;
    let pointingMarked = false;

    const base = new TurnBase(ctx, {
      timeoutMs: deps.turnTimeoutMs,
      collectUsage: () => ({
        ...(opusUsage !== undefined ? { anthropic: { opus: opusUsage } } : {}),
        ...(lease ? { openai: lease.turnUsage() } : {}),
        ...(hybrid ? { scribeSeconds: scribe!.seconds } : {}),
      }),
    });
    const scribe = hybrid ? new LazyScribe(base, deps) : null;

    const listener: RealtimeListener = {
      onAudio(pcm) {
        if (base.isFinished || !session) return;
        const seg: Segment = session.currentSegment;
        if (!writer || writer.label !== seg) {
          writer?.end();
          writer = base.output.segment(seg);
        }
        writer.push(pcm);
      },
      onText(d) {
        // Separate the ack's transcript from the answer's ("…now." + "The grid…").
        const seg = session?.currentSegment ?? "ack";
        if (seg !== textSeg && base.voiceText && !/\s$/.test(base.voiceText)) d = " " + d;
        textSeg = seg;
        base.voice(d);
      },
      onToolCall: (call) => handleTool(call),
      onError: (e) => base.fail("openai", e),
    };

    function acquire(): Promise<RealtimeLease> {
      if (!leaseP) {
        const t0 = performance.now();
        leaseP = tag("openai", acquireRealtime(ctx, deps, base.mark, listener, warm)).then((l) => {
          base.onCleanup((reason) => l.release(reason !== "done" && responding && !responsesDone));
          if (base.isFinished) throw new Error("turn already finished");
          lease = l;
          session = l.session;
          base.markMeta["llm.request"] = { cold: l.cold, reused: l.reused, openMs: Math.round(performance.now() - t0) };
          base.markMeta["turn.end"] = { cold: l.cold };
          l.session.setMark(base.mark);
          l.session.beginTurn();
          for (const b of audioBuf.splice(0)) l.session.pushAudio(b);
          return l;
        });
        leaseP.catch(() => {});
      }
      return leaseP;
    }

    function handleTool(call: ToolCall): void {
      const s = session;
      if (base.isFinished || !s) return;
      if (call.name !== "ask_opus") {
        s.sendToolResult(call.callId, JSON.stringify({ error: `unknown tool ${call.name}` }));
        pendingTool = Promise.resolve();
        return;
      }
      toolSeen = true;
      const args = (call.args ?? {}) as { question?: unknown; pointing_context?: unknown };
      const q = typeof args.question === "string" && args.question.trim() ? args.question.trim() : base.transcript || "(question not captured)";
      const question = typeof args.pointing_context === "string" && args.pointing_context.trim()
        ? `${q}\n(Voice model's note on what the user pointed at: ${args.pointing_context.trim()})`
        : q;
      let sent = false;
      let resolveTool!: () => void;
      pendingTool = new Promise<void>((r) => (resolveTool = r));
      const sendResult = (line: string) => {
        if (sent || base.isFinished) return;
        sent = true;
        s.sendToolResult(call.callId, `${line.trim()}\n\n${TOOL_RESULT_NOTE}`);
        resolveTool();
      };
      opusRuns.push(
        deps.solveWithOpus({ mark: base.mark, question, pointing: base.pointing, fast: cfg.opusFast, onSpokenLine: sendResult, onDelta: (d) => base.opus(d) })
          .then((r) => {
            opusUsage = r.usage;
            // Normally onSpokenLine already fired; if not, speak the start of the answer.
            if (!sent) sendResult(r.text.split(/\n\s*\n/)[0]!.replace(/^SPOKEN:\s*/i, "").slice(0, 400) || "I couldn't get an answer.");
          })
          .catch((e) => base.fail("opus", e)),
      );
    }

    function onFinal(fin: { text: string; words: import("../../shared/protocol.ts").Word[] }): void {
      finalArrived = true;
      base.sttFinal(fin.text, fin.words);
      pointingMarked = true;
      base.resolvePointing(fin.words, responding ? { pointingMissed: true, late: true } : {});
    }

    async function run(): Promise<void> {
      let finalSettled: Promise<void> = Promise.resolve();
      if (scribe) {
        scribe.commit();
        const finalP = tag("scribe", scribe.final());
        finalSettled = finalP.then(onFinal, (e) => { if (!base.isFinished) base.softError("scribe", e); });
        if (cfg.hybridWaitMs > 0) await Promise.race([finalSettled, sleep(cfg.hybridWaitMs)]);
      }
      const l = await acquire();
      if (base.isFinished) return;
      let context: string | undefined;
      if (scribe) {
        if (finalArrived) context = formatPointingContext(base.pointing) || undefined;
        base.markMeta["llm.request"] = { ...base.markMeta["llm.request"], pointingInjected: !!context, pointingMissed: !finalArrived };
      }
      responding = true;
      l.session.commitAndRespond(context);

      for (let i = 0; i < MAX_RESPONSES; i++) {
        await tag("openai", l.session.responseDone());
        if (base.isFinished) return;
        if (!pendingTool) break;
        const p = pendingTool;
        pendingTool = null;
        await p; // tool result sent → the adapter issues response.create for the answer
        if (base.isFinished) return;
      }
      responsesDone = true;
      writer?.end();
      await Promise.all(opusRuns);
      if (scribe) {
        await Promise.race([finalSettled, sleep(deps.hybridLateWaitMs ?? 2000)]);
        if (!pointingMarked && !base.isFinished) {
          base.mark("pointing.resolved", { targets: 0, pointingMissed: true, arrived: false });
          ctx.send({ type: "pointing.resolved", turnId: ctx.turnId, targets: [] });
        }
      }
      if (base.isFinished) return;
      const ackIsAnswer = !toolSeen && base.output.sent.includes("ack");
      base.finish(ackIsAnswer ? { ackIsAnswer } : {});
    }

    // turn.start: pre-warm (reuse the connection's session, or open it now) and the Scribe socket.
    if (warm) {
      acquire().catch((e) => base.fail(e instanceof Tagged ? e.source : "openai", e));
      scribe?.open().catch(() => {}); // non-fatal in C: reported (softError) when final() is awaited on release
    }

    return {
      onAudio(pcm) {
        if (base.isFinished) return;
        if (session) session.pushAudio(pcm);
        else audioBuf.push(pcm);
        scribe?.push(pcm);
      },
      onRelease() {
        // Cold: sockets open now, so their setup time is inside the measured latency (meta cold: true).
        run().catch((e) => base.fail(e instanceof Tagged ? e.source : "orchestrator", e));
      },
      cancel: () => base.cancel(),
      done: base.done,
    };
  };
}

export const createRealtimeOrchestrator = (deps: OrchestratorDeps): Orchestrator => createRealtimeLikeOrchestrator(deps, false);
export const realtimeOrchestrator: Orchestrator = createRealtimeOrchestrator(realDeps);
