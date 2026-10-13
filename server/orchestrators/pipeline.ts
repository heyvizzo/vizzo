// Approach B (pipeline): Scribe → pointing → Haiku router → ElevenLabs TTS, with Opus for hard tasks.
// ARCHITECTURE §7, PRD §4.
//
// turn.start (prewarm): open Scribe and the first TTS socket. Audio → Scribe. release → commit → final
// → resolvePointing → routeWithHaiku; its spoken deltas stream into the first TTS socket, which is
// flushed as soon as the ack is complete (onSpokenEnd) or when the router returns. If delegated: open
// the "answer" TTS socket when Opus is requested, push Opus's SPOKEN line into it and flush.
//
// Labels: forced mode → the router's speech is always the "ack". Auto mode → `kind` on the first
// spoken delta decides: "ack" (it called ask_opus) or "answer" (it answered directly). The first TTS
// socket is opened before the label is known, so its *.ttsFirstByte mark is renamed to the final label.
import type { Segment } from "../../shared/protocol.ts";
import type { TtsStream } from "../adapters/types.ts";
import { realDeps } from "./deps.ts";
import { LazyScribe } from "./shared.ts";
import { getConversation } from "../conversation.ts";
import { errMessage, relabelTtsMark, TurnBase, type SegmentWriter } from "./turnBase.ts";
import type { Orchestrator, OrchestratorDeps } from "./types.ts";

class Tagged extends Error {
  constructor(readonly source: string, cause: unknown) { super(errMessage(cause)); }
}
const tag = <T>(source: string, p: Promise<T>): Promise<T> => p.catch((e) => { throw e instanceof Tagged ? e : new Tagged(source, e); });

/** One TTS socket = one segment. Text/flush before the socket opens are queued. */
class SegmentTts {
  label: Segment | null = null;
  private writer: SegmentWriter | null = null;
  private stream: TtsStream | null = null;
  private textQueue: string[] = [];
  private flushed = false;
  private preAudio: Buffer[] = [];
  private used = false;
  readonly ready: Promise<TtsStream>;

  constructor(private base: TurnBase, deps: OrchestratorDeps, voiceId: string, hint: Segment) {
    const cfg = base.ctx.config;
    this.ready = tag("tts", base.track(deps.openTts({
      mark: relabelTtsMark(base.mark, () => this.label ?? hint), voiceId, model: cfg.ttsModel, segment: hint,
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

  /** Resolves when the segment's audio is complete (the socket closed). Unused sockets are closed. */
  async done(): Promise<void> {
    try {
      const s = await this.ready;
      if (!this.used) { s.close(); return; }
      this.flush();
      await tag("tts", s.done());
    } finally {
      this.writer?.end();
    }
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
    let haikuUsage: unknown = undefined;
    let opusUsage: unknown = undefined;

    const base = new TurnBase(ctx, {
      timeoutMs: deps.turnTimeoutMs,
      collectUsage: () => ({
        ...(haikuUsage !== undefined || opusUsage !== undefined
          ? { anthropic: { ...(haikuUsage !== undefined ? { haiku: haikuUsage } : {}), ...(opusUsage !== undefined ? { opus: opusUsage } : {}) } }
          : {}),
        elevenChars: ttsStreams.reduce((n, t) => n + t.chars, 0),
        scribeSeconds: scribe.seconds,
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
    if (warm) {
      scribe.open().catch(() => {}); // failure surfaces from final() on release
      firstTts = openTts("ack");
    }

    async function run(): Promise<void> {
      if (!voiceId) throw new Tagged("tts", new Error("ELEVENLABS_VOICE_ID not set"));
      const fin = await tag("scribe", scribe.final());
      if (base.isFinished) return;
      base.sttFinal(fin.text, fin.words);
      const pointing = base.resolvePointing(fin.words);

      let label: Segment | null = cfg.routerMode === "forced" ? "ack" : null;
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
      const route = await tag("haiku", deps.routeWithHaiku({
        mark: base.mark, transcript: fin.text, pointing, mode: cfg.routerMode, history,
        onSpokenDelta: (d, kind) => {
          if (base.isFinished) return;
          if (!label) label = kind;
          else if (kind !== label && cfg.routerMode === "auto") labelConflict = true; // text, then a tool call
          ensureSpoken(label).pushText(d);
          base.voice(d);
        },
        onSpokenEnd: () => spoken?.flush(),
      }));
      haikuUsage = route.usage;
      if (base.isFinished) return;
      const first = spoken as SegmentTts | null;
      first?.flush();
      if (firstTts) { firstTts.done().catch(() => {}); firstTts = null; } // pre-warmed but nothing was said
      const firstDone = first ? first.done() : Promise.resolve();
      firstDone.catch(() => {});

      let answerDone: Promise<void> = Promise.resolve();
      if (route.delegate) {
        // Warm: open the answer socket now, so it's ready by the time Opus's spoken line is.
        let answerTts: SegmentTts | null = warm ? openTts("answer") : null;
        if (answerTts) answerTts.setLabel("answer");
        let spokenLine = false;
        const opus = await tag("opus", deps.solveWithOpus({
          mark: base.mark, question: route.delegate.question, pointing, fast: cfg.opusFast, history,
          onDelta: (d) => base.opus(d),
          onSpokenLine: (line) => {
            if (base.isFinished || spokenLine) return;
            spokenLine = true;
            answerTts ??= openTts("answer");
            answerTts.setLabel("answer");
            base.voice((base.voiceText && !/\s$/.test(base.voiceText) ? " " : "") + line);
            answerTts.pushText(line);
            answerTts.flush();
          },
        }));
        opusUsage = opus.usage;
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
        scribe.commit();
        run().catch((e) => base.fail(e instanceof Tagged ? e.source : "orchestrator", e));
      },
      cancel: () => base.cancel(),
      done: base.done,
    };
  };
}

export const pipelineOrchestrator: Orchestrator = createPipelineOrchestrator(realDeps);
