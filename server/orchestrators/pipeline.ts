// The pipeline: STT (Scribe) → pointing → router → TTS, with the solver for hard tasks.
// ARCHITECTURE §7, PRD §4.
//
// turn.start (prewarm): open Scribe and the first TTS socket. Audio → Scribe. release → commit → final
// → resolvePointing → routeTurn; its spoken deltas stream into the first TTS socket, which is
// flushed as soon as the ack is complete (onSpokenEnd) or when the router returns. If delegated: open
// the "answer" TTS socket when the solver is requested, push the solver's SPOKEN line into it and flush.
//
// Labels: forced mode → the router's speech is always the "ack". Auto mode → `kind` on the first
// spoken delta decides: "ack" (it called ask_solver) or "answer" (it answered directly). The first TTS
// socket is opened before the label is known, so its *.ttsFirstByte mark is renamed to the final label.
//
// Element threads (RunConfig.threads, docs/PLAN-threads.md): after pointing, the turn's anchor and the thread briefs
// go to the router; its target sends the turn to a new thread (a short new question still answers inline, recorded
// in the thread), an existing one (follow-up queued / correction restarts, after the ack), a tell (the thread's
// latest result is this turn's answer) or the central conversation (as without threads).
// A thread that always uses the smart model (ThreadInfo.alwaysSmart), from its open panel: a spoken turn goes to the
// router in forced mode (it only speaks the ack); a typed one skips it and goes straight to the thread's harness session.
//
// Typed comments (ctx.typedText, shared/comment.ts): the text stands in for Scribe's final, on a synthetic timeline.
// With config.silent (set for them) nothing is spoken: the TTS sockets are stand-ins and there are no fillers, so the
// reply is only text (voice.text), and the thread runs it starts announce their results as text too.
import type { Segment } from "../../shared/protocol.ts";
import { hasSpokenWords, isNoSpeechNote } from "../../shared/speech.ts";
import { typedWords } from "../../shared/comment.ts";
import { tracer } from "./trace.ts";
import type { RouteDecision, TtsStream } from "../adapters/types.ts";
import { realDeps } from "./deps.ts";
import { useVoiceCues } from "../adapters/voiceCues.ts";
import { sttUsage } from "../cost.ts";
import { LazyScribe } from "./shared.ts";
import { getConversation } from "../conversation.ts";
import { errMessage, relabelTtsMark, TurnBase, type SegmentWriter } from "./turnBase.ts";
import { FillerScheduler } from "./fillers.ts";
import { isLocalTts, taskTimeoutMs } from "../../shared/config.ts";
import { startJob } from "./jobs.ts";
import { browserUrl } from "../browserPage.ts";
import { threadStore } from "../threads/store.ts";
import { correctRun, submitRun, type RunSpec } from "../threads/runner.ts";
import { startedLine } from "../threads/policy.ts";
import { planThread, prepareThreads, threadsEnabled, type ThreadPlan } from "../threads/turn.ts";
import type { Orchestrator, OrchestratorDeps } from "./types.ts";

class Tagged extends Error {
  constructor(readonly source: string, cause: unknown) { super(errMessage(cause)); }
}
const tag = <T>(source: string, p: Promise<T>): Promise<T> => p.catch((e) => { throw e instanceof Tagged ? e : new Tagged(source, e); });

/** config.silent: a TTS "socket" that says nothing (the text still goes out as voice.text). */
const silentTts = async (): Promise<TtsStream> => ({
  pushText() {}, flush() {}, onAudio() {}, done: async () => {}, close() {}, chars: 0,
});

/** The cut-in when the progress lines came without one (generateFillers' cutIn). */
function fallbackCutIn(intent: string, language: string | undefined): string {
  const ro = language?.startsWith("ro");
  if (intent === "task") return ro ? "A, stai, gata." : "Oh, wait, it's finished.";
  return ro ? "A, stai, uite." : "Oh, wait, here it is.";
}

/** One TTS socket = one segment. Text/flush before the socket opens are queued. */
class SegmentTts {
  label: Segment | null = null;
  private writer: SegmentWriter | null = null;
  private stream: TtsStream | null = null;
  private textQueue: string[] = [];
  private flushed = false;
  private preAudio: Buffer[] = [];
  private used = false;
  /** Set by cut(): done() stops waiting for the socket. */
  private cutOff: (() => void) | null = null;
  private readonly cutP = new Promise<void>((r) => { this.cutOff = r; });
  readonly ready: Promise<TtsStream>;

  constructor(private base: TurnBase, deps: OrchestratorDeps, voiceId: string, hint: Segment) {
    const cfg = base.ctx.config;
    this.ready = tag("tts", base.track((cfg.silent ? silentTts : deps.openTts)({
      mark: relabelTtsMark(base.mark, () => this.label ?? hint), voiceId, model: cfg.ttsModel, segment: hint === "answer" ? "answer" : "ack",
      language: () => base.language,
      ...(cfg.ttsVoice ? { voice: cfg.ttsVoice } : {}),
      style: cfg.ttsStyle,
    }))).then((s) => {
      this.stream = s;
      s.onAudio((pcm) => (this.writer ? this.writer.push(pcm) : this.preAudio.push(pcm)));
      for (const t of this.textQueue.splice(0)) s.pushText(t);
      if (this.flushed) s.flush();
      return s;
    });
    this.ready.catch((e) => base.fail("tts", e)); // fail fast, even if nothing awaits this socket yet
  }

  setLabel(label: Segment): void {
    if (this.label) return;
    this.label = label;
    this.writer = this.base.output.segment(label);
    for (const b of this.preAudio.splice(0)) this.writer.push(b);
  }

  pushText(d: string): void {
    if (this.flushed || !d) return;
    this.used = true;
    if (this.stream) this.stream.pushText(d);
    else this.textQueue.push(d);
  }

  flush(): void {
    if (this.flushed || !this.used) return;
    this.flushed = true;
    this.stream?.flush();
  }

  /** Resolves when the segment's audio is complete (the socket closed), or it was cut. Unused sockets are closed. */
  async done(): Promise<void> {
    try {
      const s = await Promise.race([this.ready, this.cutP.then(() => null)]);
      if (!s) return;
      if (!this.used) { s.close(); return; }
      this.flush();
      const finished = tag("tts", s.done());
      finished.catch(() => {}); // cut: nobody waits for it any more
      await Promise.race([finished, this.cutP]);
    } finally {
      this.writer?.end();
    }
  }

  /**
   * Stop it mid-sentence: no more synthesis, its unsent audio dropped, the client told to stop playing it. Returns
   * whether the user was hearing it (SegmentOutput.cut), so what comes next can say why it broke off.
   */
  cut(): boolean {
    this.flushed = true;
    this.textQueue = [];
    this.stream?.close();
    this.ready.then((s) => s.close(), () => {});
    const heard = this.writer ? this.base.output.cut(this.writer) : false;
    this.cutOff?.();
    return heard;
  }

  get chars(): number { return this.stream?.chars ?? 0; }
}

export function createPipelineOrchestrator(deps: OrchestratorDeps): Orchestrator {
  return (ctx) => {
    const cfg = ctx.config;
    // Chat mode: a snapshot of the earlier turns (this turn is appended by the Session when it ends).
    const history = cfg.memory ? [...getConversation(ctx.connection)] : undefined;
    const warm = cfg.prewarm;
    const voiceId = deps.voiceId ?? process.env.ELEVENLABS_VOICE_ID ?? "";
    const ttsStreams: SegmentTts[] = [];
    let routerUsage: unknown = undefined;
    let solverUsage: unknown = undefined;
    let fillerUsage: unknown = undefined;

    const base = new TurnBase(ctx, {
      timeoutMs: deps.turnTimeoutMs,
      collectUsage: () => ({
        ...(routerUsage !== undefined || solverUsage !== undefined
          ? { anthropic: {
            ...(routerUsage !== undefined ? { router: routerUsage } : {}),
            ...(solverUsage !== undefined ? { solver: solverUsage } : {}),
            ...(fillerUsage ? { fillers: fillerUsage } : {}),
          } }
          : {}),
        // On-device speech isn't billed: its characters are counted separately (shown as saved vs ElevenLabs).
        ...(isLocalTts(cfg.ttsModel)
          ? { localTtsChars: ttsStreams.reduce((n, t) => n + t.chars, 0) }
          : cfg.ttsModel === "openai_tts_1"
            ? { openaiTtsChars: ttsStreams.reduce((n, t) => n + t.chars, 0) }
            : cfg.ttsModel === "fish_drama_3"
              ? { fishTtsChars: ttsStreams.reduce((n, t) => n + t.chars, 0) }
              : { elevenChars: ttsStreams.reduce((n, t) => n + t.chars, 0) }),
        elevenSegments: ttsStreams.filter((t) => t.chars > 0).map((t) => ({ label: t.label ?? "tts", chars: t.chars })),
        ...sttUsage(cfg.sttModel, scribe.seconds),
      }),
    });
    const scribe = new LazyScribe(base, deps);
    const openTts = (hint: Segment): SegmentTts => {
      const t = new SegmentTts(base, deps, voiceId, hint);
      ttsStreams.push(t);
      return t;
    };
    base.markMeta["llm.request"] = { cold: !warm };
    base.markMeta["turn.end"] = { cold: !warm };

    // Pre-warm: Scribe + the first TTS socket (at most one pre-warmed v4 dialogue socket, API-NOTES).
    let firstTts: SegmentTts | null = null;
    const typed = ctx.typedText;
    if (warm) {
      if (typed === undefined) scribe.open().catch(() => {}); // failure surfaces from final() on release
      firstTts = openTts("ack");
    }

    async function run(): Promise<void> {
      if (!cfg.silent && !voiceId && cfg.ttsModel.startsWith("eleven_")) throw new Tagged("tts", new Error("ELEVENLABS_VOICE_ID not set"));
      const fin = typed !== undefined ? { text: typed.trim(), words: typedWords(typed), language: undefined } : await tag("scribe", scribe.final());
      if (base.isFinished) return;
      // Always-listen: a bump or a room noise that produced no words never reaches the router. Neither does a
      // recognizer's note that nothing was said ("(nothing heard)", "[BLANK_AUDIO]"), in any mode.
      const noSpeechNote = typed === undefined && isNoSpeechNote(fin.text);
      if ((ctx.autoEndpoint?.() || noSpeechNote) && !hasSpokenWords(fin.text, fin.words)) {
        base.markMeta["turn.end"] = { ...base.markMeta["turn.end"], skipped: noSpeechNote ? "no-speech-note" : "no-words" };
        base.finish();
        return;
      }
      base.sttFinal(fin.text, fin.words, fin.language);
      const pointing = base.resolvePointing(fin.words);
      const pageContext = base.pageContext() || undefined;
      const solverContext = base.pageContext(undefined, { elements: "full" }) || undefined;

      // The router's intent decides the label: question/task → its speech is the "ack"; clarify/answer → "answer".
      let label: Segment | null = null;
      let spoken: SegmentTts | null = null;
      let labelConflict = false;
      const ensureSpoken = (l: Segment): SegmentTts => {
        if (!spoken) {
          spoken = firstTts ?? openTts(l);
          firstTts = null;
          spoken.setLabel(l);
        }
        return spoken;
      };
      const trace = tracer((m) => { if (!base.isFinished) ctx.send(m); }, ctx.turnId);
      const smart = ctx.pinnedThread && threadsEnabled(cfg, deps, ctx) ? threadStore().info(ctx.pinnedThread) : undefined;
      if (smart?.alwaysSmart && typed !== undefined) {
        if (firstTts) { firstTts.done().catch(() => {}); firstTts = null; } // nothing is said in this turn
        if (!fin.text) return base.finish({ transcript: "" });
        const store = threadStore();
        const { threadId, intent } = smart;
        const msg = store.addMessage(threadId, { turnId: ctx.turnId, role: "user", kind: "followup", text: fin.text, annotation: ctx.annotation });
        store.bump(threadId);
        base.markMeta["turn.end"] = { ...base.markMeta["turn.end"], intent, estimateS: null, background: true, threadId, relation: "direct" };
        ctx.send({ type: "decision", turnId: ctx.turnId, intent, estimateS: null, background: true, threadId });
        submitRun(threadId, {
          kind: "direct", question: fin.text, turnId: ctx.turnId, config: cfg, intent, pointing,
          annotation: ctx.annotation, pageContext: solverContext, language: base.language, messageId: msg?.id,
        }, deps).catch((e) => console.warn("[threads] run failed", e));
        base.finish();
        return;
      }
      const canBackground = cfg.memory && cfg.backgroundLongTasks && !!ctx.channel;
      // Element threads: the element this turn is about and what the router is told about the threads.
      // A turn with a focus stays there: the message box's in the conversation, an open panel's in its thread.
      // Typed (no speech) stays on the click. Only spoken with no focus can move to an existing thread it names.
      const clicks = ctx.pageEvents?.().clicks;
      const chatTurn = typed !== undefined && !!ctx.chat;
      const typedTurn = typed !== undefined && !ctx.annotation && !chatTurn;
      const spokenClick = !typedTurn && !ctx.annotation && !ctx.pinnedThread && !!clicks?.some((c) => c.elementPath);
      const tt = threadsEnabled(cfg, deps, ctx)
        ? prepareThreads({
          annotation: ctx.annotation, words: fin.words, pointing, rests: base.rests, samples: ctx.cursorSamples(),
          pageUrl: ctx.pageUrl?.() ?? browserUrl() ?? "", ...(clicks?.length ? { clicks } : {}),
        }, undefined, ctx.pinnedThread, { clicked: typedTurn || spokenClick, typed: typedTurn, chat: chatTurn })
        : null;
      if (tt?.pinnedMissing) {
        // The open panel's thread is gone: say so rather than route the message somewhere else.
        if (firstTts) { firstTts.done().catch(() => {}); firstTts = null; }
        base.softError("threads", new Error("That thread no longer exists, so the message wasn't sent. Close its panel and try again."));
        base.finish({ transcript: "" });
        return;
      }
      const th: { plan: ThreadPlan | null } = { plan: null };
      let background = false;
      let decided = false;
      const decide = (d: RouteDecision, final = false): void => {
        if (decided || base.isFinished) return;
        if (tt && !final && d.target === undefined && d.tell === undefined) return; // wait for the target
        decided = true;
        const { intent, estimateS } = d;
        const delegated = intent === "question" || intent === "task";
        const long = estimateS !== null && estimateS > cfg.longTaskSeconds;
        th.plan = tt ? planThread(d, tt) : null;
        const plan = th.plan;
        // A thread's work runs on its runner after the ack, except a short NEW question (answered inline).
        background = plan
          ? delegated && plan.relation !== "tell" && (plan.relation !== "new" || long)
          : canBackground && delegated && long;
        const threadId = plan ? { threadId: plan.threadId } : {};
        base.markMeta["turn.end"] = { ...base.markMeta["turn.end"], intent, estimateS, background, ...threadId, ...(plan ? { relation: plan.relation } : {}) };
        ctx.send({ type: "decision", turnId: ctx.turnId, intent, estimateS, background, ...threadId });
      };
      const route = await tag("router", deps.routeTurn({
        mark: base.mark, transcript: base.markedTranscript(), pointing, mode: smart?.alwaysSmart ? "forced" : cfg.routerMode, history, annotation: ctx.annotation, pageContext, language: base.language,
        voiceCues: useVoiceCues(cfg.ttsModel, base.language),
        longTaskSeconds: cfg.backgroundLongTasks || tt ? cfg.longTaskSeconds : undefined, llm: cfg.llm.fast,
        ...(tt ? {
          threads: tt.briefs, ...(tt.anchorLabel ? { anchorLabel: tt.anchorLabel } : {}),
          ...(tt.clicked && !tt.typed ? { clicked: true } : {}), ...(tt.typed ? { typed: true } : {}), ...(tt.chat ? { chat: true } : {}),
          ...(tt.pinned && !tt.typed && tt.anchorLabel ? { panel: tt.anchorLabel } : {}),
        } : {}),
        onDecision: (d) => decide(d),
        ...trace(),
        onSpokenDelta: (d, kind) => {
          if (base.isFinished) return;
          if (!label) label = kind;
          else if (kind !== label) labelConflict = true;
          ensureSpoken(label).pushText(d);
          base.voice(d);
        },
        onSpokenEnd: () => spoken?.flush(),
      }));
      routerUsage = route.usage;
      if (base.isFinished) return;
      decide(route.decision, true);
      // The router judged the transcript a description of silence: no reply, and nothing kept in the conversation.
      if (!route.delegate && !route.decision.tell && route.decision.intent === "clarify" && !base.voiceText.trim()) {
        base.markMeta["turn.end"] = { ...base.markMeta["turn.end"], skipped: "router-silent" };
        if (firstTts) { firstTts.done().catch(() => {}); firstTts = null; }
        base.finish({ transcript: "" });
        return;
      }
      const first = spoken as SegmentTts | null;
      first?.flush();
      if (firstTts) { firstTts.done().catch(() => {}); firstTts = null; } // pre-warmed but nothing was said
      const firstDone = first ? first.done() : Promise.resolve();
      firstDone.catch(() => {});

      let answerDone: Promise<void> = Promise.resolve();
      const delegate = route.delegate;
      const plan = th.plan;
      const store = threadStore();
      const sep = () => (base.voiceText && !/\s$/.test(base.voiceText) ? " " : "");
      let threadSpec: RunSpec | null = null;
      if (plan && plan.relation !== "tell") {
        // Record the turn in its thread: the user's words, then what was said right away.
        const kind = plan.relation === "new" ? "request" : plan.relation;
        const msg = store.addMessage(plan.threadId, { turnId: ctx.turnId, role: "user", kind, text: fin.text || delegate?.question || "", annotation: ctx.annotation });
        if (plan.relation !== "new") store.bump(plan.threadId);
        if (base.voiceText.trim()) {
          store.addMessage(plan.threadId, { turnId: ctx.turnId, role: "assistant", kind: delegate ? "ack" : "result", text: base.voiceText.trim() }, (t) => {
            if (!delegate) t.awaitingReply = route.decision.intent === "clarify";
          });
        }
        if (delegate) {
          threadSpec = {
            kind, question: delegate.question, turnId: ctx.turnId, config: cfg, intent: delegate.intent, pointing,
            annotation: ctx.annotation, pageContext: solverContext, language: base.language, messageId: msg?.id,
          };
        }
      }

      // From the message box, a tell reads the thread's result here: the turn stays in the conversation.
      const told = plan?.relation === "tell" ? plan.threadId
        : tt?.chat && route.decision.tell && store.info(route.decision.tell) ? route.decision.tell : null;
      if (told) {
        // "Tell me about the red button": its latest result is this turn's answer (the router said nothing).
        const last = store.info(told)?.messages.findLast((m) => m.kind === "result");
        if (last) {
          const t = openTts("answer");
          t.setLabel("answer");
          base.voice(sep() + last.text, true);
          t.pushText(last.text);
          t.flush();
          if (last.detail) base.solver(last.detail);
          answerDone = t.done();
          answerDone.catch(() => {});
        }
        store.focus(told); // told: read, idle, focused
      } else if (plan && threadSpec && background) {
        // The ack said "I'll let you know": the run goes on the thread's runner and outlives this turn.
        const spec = threadSpec;
        const info = store.info(plan.threadId);
        if (plan.relation === "new" && info) {
          store.conversation.push({ turnId: `${plan.threadId}:start`, approach: cfg.approach, user: "(Task update)", assistant: startedLine(info.title, spec.question), detail: "" });
        }
        const p = plan.relation === "correction" ? correctRun(plan.threadId, spec, deps) : submitRun(plan.threadId, spec, deps);
        p.catch((e) => console.warn("[threads] run failed", e));
      } else if (delegate && background) {
        // Long task: the ack said "I'll get back to you"; the solver runs as a job that outlives this turn.
        const job = startJob(ctx.connection, ctx.channel!, deps, {
          turnId: ctx.turnId, config: cfg, intent: delegate.intent, question: delegate.question,
          estimateS: delegate.estimateS, pointing, history: history ?? [], annotation: ctx.annotation, pageContext: solverContext, language: base.language,
        });
        base.markMeta["turn.end"] = { ...base.markMeta["turn.end"], jobId: job.jobId };
      } else if (delegate) {
        // Warm: open the answer socket now, so it's ready by the time the solver's spoken line is. Its segment
        // is only created when the line arrives, so filler segments queue before it.
        let answerTts: SegmentTts | null = warm ? openTts("answer") : null;
        let spokenLine = false;
        let cutIn: string | undefined;
        const fillers = cfg.fillers && !cfg.silent && deps.generateFillers
          ? new FillerScheduler(
            base,
            deps.generateFillers({ transcript: fin.text, question: delegate.question, intent: delegate.intent, pointing, language: base.language, voiceCues: useVoiceCues(cfg.ttsModel, base.language), llm: cfg.llm.fast, ...trace() })
              .then((r) => { fillerUsage = r.usage; cutIn = r.cutIn; return r.lines; }),
            (line) => {
              const t = openTts("filler");
              t.setLabel("filler");
              base.voice(sep() + line, true);
              t.pushText(line);
              t.flush();
              return { done: t.done(), cut: () => t.cut() };
            },
          )
          : null;
        const onSpokenLine = (line: string): void => {
          if (base.isFinished || spokenLine) return;
          spokenLine = true;
          // The answer doesn't wait for a progress line to end: it's broken off, and if that was heard, the answer
          // starts by saying why ("Oh, wait, here it is."). A line that had ended, or was about to, isn't.
          const cut = fillers?.cut() ?? false;
          const said = cut ? `${cutIn ?? fallbackCutIn(delegate.intent, base.language)} ${line}` : line;
          if (cut) base.markMeta["turn.end"] = { ...base.markMeta["turn.end"], fillerCut: true };
          answerTts ??= openTts("answer");
          answerTts.setLabel("answer");
          base.voice(cut ? ` — ${said}` : sep() + said, true);
          answerTts.pushText(said);
          answerTts.flush();
        };
        const onDelta = (d: string): void => base.solver(d);
        if (plan && threadSpec) {
          // A short new question on an element: answered in this turn, in the thread's own harness session.
          const r = await tag("solver", submitRun(plan.threadId, {
            ...threadSpec, inline: { mark: base.mark, trace, onSpokenLine, onDelta, active: () => !base.isFinished },
          }, deps));
          if (r) solverUsage = r.usage;
        } else {
          const solved = await tag("solver", deps.solveTask({
            mark: base.mark, question: delegate.question, pointing, fast: cfg.solverFast, history, intent: delegate.intent, annotation: ctx.annotation, pageContext: solverContext, language: base.language, llm: cfg.llm.smart,
            timeoutMs: taskTimeoutMs(cfg), voiceCues: useVoiceCues(cfg.ttsModel, base.language),
            onDelta,
            ...trace(),
            onSpokenLine,
          }));
          solverUsage = solved.usage;
        }
        fillers?.stop();
        if (fillers) {
          base.markMeta["turn.end"] = { ...base.markMeta["turn.end"], fillers: fillers.spoken.length };
          await fillers.done;
        }
        if (answerTts) {
          answerDone = answerTts.done();
          answerDone.catch(() => {});
        }
      }
      await firstDone;
      await answerDone;
      if (base.isFinished) return;
      if (labelConflict) base.markMeta["turn.end"] = { ...base.markMeta["turn.end"], labelConflict: true };
      base.finish();
    }

    return {
      onAudio(pcm) {
        if (!base.isFinished) scribe.push(pcm);
      },
      onRelease() {
        if (typed === undefined) scribe.commit();
        run().catch((e) => base.fail(e instanceof Tagged ? e.source : "orchestrator", e));
      },
      cancel: () => base.cancel(),
      done: base.done,
    };
  };
}

export const pipelineOrchestrator: Orchestrator = createPipelineOrchestrator(realDeps);
