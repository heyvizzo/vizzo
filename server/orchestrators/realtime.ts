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
import { annotateTranscript, formatPointingContext } from "../../shared/pointing.ts";
import type { Segment } from "../../shared/protocol.ts";
import type { RealtimeSession, ToolCall } from "../adapters/types.ts";
import { realDeps } from "./deps.ts";
import { acquireRealtime, LazyScribe, REALTIME_INSTRUCTIONS, type RealtimeLease, type RealtimeListener } from "./shared.ts";
import { formatHistoryRecap, getConversation } from "../conversation.ts";
import { FillerScheduler } from "./fillers.ts";
import { DEFAULT_LONG_TASK_SECONDS, languageName } from "../adapters/claude.ts";
import { startJob } from "./jobs.ts";
import type { Intent, LlmPrompt, RouteIntent } from "../../shared/protocol.ts";
import { tracer } from "./trace.ts";
import type { ChatTurn } from "../conversation.ts";
import { errMessage, sleep, TurnBase, type SegmentWriter } from "./turnBase.ts";
import type { Orchestrator, OrchestratorDeps } from "./types.ts";

/** Tool result for a long task handed to a background job: the model already said it'll get back to the user. */
export const BACKGROUND_TOOL_RESULT = "Started as a background task. The user will be told the result when it's done. Don't say anything more now.";
/** Tool result recorded when the user interrupts before Opus answered (keeps the conversation valid). */
export const CANCELLED_TOOL_RESULT = "Cancelled: the user interrupted before the answer was ready.";

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
    let fillerUsage: unknown = undefined;
    let fillers: FillerScheduler | null = null;
    /** ask_opus call still waiting for its output (answered inline): on interrupt it gets CANCELLED_TOOL_RESULT. */
    let openCall: string | null = null;
    let decided = false;
    let writer: SegmentWriter | null = null;
    let audioBytes = 0;
    const trace = tracer((m) => { if (!base.isFinished) ctx.send(m); }, ctx.turnId);
    /** The Realtime call of this turn: its prompt, then one response per response.done. */
    const rtCall = trace();
    let rtT0 = 0;
    let textSeg: Segment = "ack";
    // hybrid
    let finalArrived = false;
    let pointingMarked = false;

    const base = new TurnBase(ctx, {
      timeoutMs: deps.turnTimeoutMs,
      collectUsage: () => ({
        ...(opusUsage !== undefined || fillerUsage ? { anthropic: { ...(opusUsage !== undefined ? { opus: opusUsage } : {}), ...(fillerUsage ? { fillers: fillerUsage } : {}) } } : {}),
        ...(lease ? { openai: lease.turnUsage() } : {}),
        ...(scribe ? { scribeSeconds: scribe.seconds } : {}),
      }),
    });
    // C: Scribe for pointing. A in chat mode: Scribe only for the transcript (history + display); never waited on.
    const scribe = hybrid || cfg.memory ? new LazyScribe(base, deps) : null;

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
      onResponseDone: ({ label, stale, response }) => {
        if (stale || !rtT0) return;
        const r = response as { status?: string; usage?: unknown };
        rtCall.onResponse({
          target: "realtime", model: cfg.realtimeModel, label, stopReason: r.status ?? null, usage: r.usage,
          durationMs: Math.round(performance.now() - rtT0), raw: response,
        });
      },
    };

    function acquire(): Promise<RealtimeLease> {
      if (!leaseP) {
        const t0 = performance.now();
        leaseP = tag("openai", acquireRealtime(ctx, deps, base.mark, listener, warm)).then((l) => {
          base.onCleanup((reason) => {
            fillers?.stop();
            // Interrupted while Opus was still working: close the pending call so the conversation stays valid.
            if (reason !== "done" && openCall) { l.session.sendToolResult(openCall, CANCELLED_TOOL_RESULT, { respond: false }); openCall = null; }
            l.release(reason !== "done" && responding && !responsesDone);
          });
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

    function decide(intent: RouteIntent, estimateS: number | null, background: boolean): void {
      if (decided || base.isFinished) return;
      decided = true;
      base.markMeta["turn.end"] = { ...base.markMeta["turn.end"], intent, estimateS, background };
      ctx.send({ type: "decision", turnId: ctx.turnId, intent, estimateS, background });
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
      const args = (call.args ?? {}) as { question?: unknown; pointing_context?: unknown; intent?: unknown; estimated_seconds?: unknown };
      const intent: Intent = args.intent === "task" ? "task" : "question";
      const est = Number(args.estimated_seconds);
      const estimateS = Number.isFinite(est) && est > 0 ? Math.round(est) : null;
      const q = typeof args.question === "string" && args.question.trim() ? args.question.trim() : base.transcript || "(question not captured)";
      const question = typeof args.pointing_context === "string" && args.pointing_context.trim()
        ? `${q}\n(Voice model's note on what the user pointed at: ${args.pointing_context.trim()})`
        : q;
      const background = !!ctx.channel && cfg.memory && cfg.backgroundLongTasks && estimateS !== null && estimateS > cfg.longTaskSeconds;
      decide(intent, estimateS, background);
      if (background) {
        // Long task: the model already said it'll get back to the user. Record the call's output without
        // a new response, and let Opus run as a job that outlives this turn.
        s.sendToolResult(call.callId, BACKGROUND_TOOL_RESULT, { respond: false });
        pendingTool = Promise.resolve();
        const job = startJob(ctx.connection, ctx.channel!, deps, {
          turnId: ctx.turnId, config: cfg, intent, question, estimateS, pointing: base.pointing, pageContext: base.pageContext() || undefined, language: base.language,
          history: cfg.memory ? getConversation(ctx.connection).slice() : [],
        });
        base.markMeta["turn.end"] = { ...base.markMeta["turn.end"], jobId: job.jobId };
        return;
      }
      openCall = call.callId;
      let sent = false;
      let resolveTool!: () => void;
      pendingTool = new Promise<void>((r) => (resolveTool = r));
      const sendResult = (line: string) => {
        if (sent || base.isFinished) return;
        sent = true;
        openCall = null;
        fillers?.stop();
        s.sendToolResult(call.callId, `${line.trim()}\n\n${TOOL_RESULT_NOTE}`);
        resolveTool();
      };
      if (cfg.fillers && deps.generateFillers) {
        fillers = new FillerScheduler(
          base,
          deps.generateFillers({ transcript: base.transcript, question, intent, pointing: base.pointing, language: base.language, ...trace() })
            .then((r) => { fillerUsage = r.usage; return r.lines; }),
          async (line) => {
            await s.speak(line, "filler");
            // Close the filler's segment so the next line (or the answer) starts a new one after a pause.
            if (writer?.label === "filler") { writer.end(); writer = null; }
          },
        );
      }
      opusRuns.push(
        deps.solveWithOpus({
          mark: base.mark, question, pointing: base.pointing, fast: cfg.opusFast, intent, pageContext: base.pageContext() || undefined, language: base.language, ...trace(),
          onSpokenLine: sendResult, onDelta: (d) => base.opus(d),
        })
          .then((r) => {
            opusUsage = r.usage;
            // Normally onSpokenLine already fired; if not, speak the start of the answer.
            if (!sent) sendResult(r.text.split(/\n\s*\n/)[0]!.replace(/^SPOKEN:\s*/i, "").slice(0, 400) || "I couldn't get an answer.");
          })
          .catch((e) => base.fail("opus", e)),
      );
    }

    function onFinal(fin: { text: string; words: import("../../shared/protocol.ts").Word[]; language?: string }): void {
      finalArrived = true;
      base.sttFinal(fin.text, fin.words, fin.language);
      pointingMarked = true;
      base.resolvePointing(fin.words, hybrid && responding ? { pointingMissed: true, late: true } : {});
    }

    async function run(): Promise<void> {
      let finalSettled: Promise<void> = Promise.resolve();
      if (scribe) {
        scribe.commit();
        const finalP = tag("scribe", scribe.final());
        finalSettled = finalP.then(onFinal, (e) => { if (!base.isFinished) base.softError("scribe", e); });
        if (hybrid && cfg.hybridWaitMs > 0) await Promise.race([finalSettled, sleep(cfg.hybridWaitMs)]);
      }
      const l = await acquire();
      if (base.isFinished) return;
      let context: string | undefined;
      if (hybrid) {
        if (finalArrived) {
          const lines = formatPointingContext(base.pointing);
          // Always include Scribe's transcript: a dedicated recognizer, often more accurate than the model's own hearing.
          const marked = annotateTranscript(base.words, base.pointing, base.rests) ?? base.transcript;
          context = [marked ? `Transcript (from a dedicated speech recognizer; trust it over what you heard if they differ): "${marked}"` : "", lines].filter(Boolean).join("\n") || undefined;
        }
        base.markMeta["llm.request"] = { ...base.markMeta["llm.request"], pointingInjected: !!context, pointingMissed: !finalArrived };
      }
      // Clicks / highlighted text (no word timestamps needed, so A gets them too).
      const page = base.pageContext();
      if (page) context = context ? `${context}\n${page}` : page;
      // Reply language: this turn's (C, from Scribe's transcript) or, for A, the conversation's last one.
      const lang = base.language ?? (cfg.memory ? ctx.connection.get<string>("language") : undefined);
      if (lang) {
        const line = base.language
          ? `(The user is speaking ${languageName(lang)}: reply in ${languageName(lang)}.)`
          : `(The user has been speaking ${languageName(lang)}: reply in the language of this message, most likely ${languageName(lang)}.)`;
        context = context ? `${context}\n${line}` : line;
      }
      // The instructions say 20 s; tell the model when the user picked another long-task threshold.
      if (cfg.backgroundLongTasks && cfg.longTaskSeconds !== DEFAULT_LONG_TASK_SECONDS) {
        const line = `(Long-task threshold for this conversation: ${cfg.longTaskSeconds} seconds, use it instead of ${DEFAULT_LONG_TASK_SECONDS}.)`;
        context = context ? `${context}\n${line}` : line;
      }
      if (cfg.memory) {
        // Turns this session didn't hear (handled by B, or before a reopen) go in as a text recap.
        const unseen = getConversation(ctx.connection).filter((t) => !l.seenTurns.has(t.turnId));
        const recap = formatHistoryRecap(unseen);
        if (recap) context = context ? `${recap}\n\n${context}` : recap;
        for (const t of unseen) l.seenTurns.add(t.turnId);
        l.seenTurns.add(ctx.turnId);
        base.markMeta["llm.request"] = { ...base.markMeta["llm.request"], historyRecapTurns: unseen.length };
      }
      responding = true;
      rtT0 = performance.now();
      rtCall.onPrompt(realtimePrompt(cfg.realtimeModel, audioBytes, context, cfg.memory ? getConversation(ctx.connection).filter((t) => l.seenTurns.has(t.turnId) && t.turnId !== ctx.turnId) : null));
      l.session.commitAndRespond(context);

      for (let i = 0; i < MAX_RESPONSES; i++) {
        await tag("openai", l.session.responseDone());
        if (base.isFinished) return;
        if (!pendingTool) break;
        // The ack has finished: close its segment, so fillers can follow once it has played.
        if (writer && writer.label === "ack") { writer.end(); writer = null; }
        const p = pendingTool;
        pendingTool = null;
        await p; // tool result sent → the adapter issues response.create for the answer
        if (base.isFinished) return;
      }
      responsesDone = true;
      fillers?.stop();
      if (fillers) {
        await fillers.done;
        base.markMeta["turn.end"] = { ...base.markMeta["turn.end"], fillers: fillers.spoken.length };
      }
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
      // No tool call: the model either answered directly or asked a follow-up (it asks with a question mark).
      if (!toolSeen) decide(/\?\s*$/.test(base.voiceText) ? "clarify" : "answer", null, false);
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
        audioBytes += pcm.length;
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

/**
 * What the Realtime model gets for a turn (debug view): its session instructions, the earlier turns its
 * conversation holds (chat mode; null = not tracked), this turn's audio and the context item.
 */
export function realtimePrompt(model: string, audioBytes: number, context: string | undefined, heard: ChatTurn[] | null): LlmPrompt {
  const messages: LlmPrompt["messages"] = [];
  if (heard) {
    for (const t of heard) {
      messages.push({ role: "user", text: t.user || "(inaudible)", label: "earlier turn (in the session)" });
      messages.push({ role: "assistant", text: t.assistant || "(no reply)", label: "earlier turn (in the session)" });
    }
  } else {
    messages.push({ role: "system", text: "(The reused Realtime session also keeps this connection's earlier turns; not tracked outside chat mode.)", label: "note" });
  }
  messages.push({ role: "user", text: `(push-to-talk audio, ${(audioBytes / 48000).toFixed(1)} s, sent as input_audio_buffer)`, label: "this turn · audio" });
  if (context) messages.push({ role: "user", text: context, label: "this turn · context item" });
  return {
    target: "realtime", model,
    system: [{ label: "realtime.md (session instructions)", text: REALTIME_INSTRUCTIONS }],
    messages, tools: ["ask_opus"], toolChoice: "auto",
  };
}

