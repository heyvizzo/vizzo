// cursor-only approach (TASKS T9): STT (the configured Speech model) + pointing resolution, no LLM, no TTS.
import { SAMPLE_RATE } from "../../shared/config.ts";
import { computeRests, languagesFor, normalizeLanguage, resolvePointing } from "../../shared/pointing.ts";
import type { PointingTarget } from "../../shared/protocol.ts";
import { openStt } from "./deps.ts";
import { sttUsage } from "../cost.ts";
import type { OpenScribe, SttStream } from "../adapters/types.ts";
import type { Orchestrator, TurnResult } from "./types.ts";

/** `open` is injectable for tests. */
export function createCursorOnlyOrchestrator(open: OpenScribe = openStt): Orchestrator {
  return (ctx) => {
    const { turnId, config } = ctx;
    let stt: SttStream | null = null;
    let cancelled = false;
    let audioBytes = 0;
    const pending: Buffer[] = []; // audio that arrives before Scribe is open
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let cancel!: (e: Error) => void;
    const cancelledP = new Promise<never>((_, rej) => (cancel = rej));
    cancelledP.catch(() => {});

    const run = async (): Promise<TurnResult> => {
      let s: SttStream;
      try {
        const lang = config.language;
        s = await Promise.race([open({ mark: ctx.mark, model: config.sttModel, ...(lang && lang !== "auto" ? { language: lang } : {}) }), cancelledP]);
      } catch (e) {
        if (!cancelled) ctx.send({ type: "error", turnId, source: "scribe", message: String(e) });
        throw e;
      }
      if (cancelled) {
        s.close();
        throw new Error("cancelled");
      }
      stt = s;
      try {
        s.onPartial((text) => ctx.send({ type: "stt.partial", turnId, text }));
        for (const b of pending.splice(0)) s.pushAudio(b);
        await Promise.race([released, cancelledP]);
        s.commit();
        const { text, words, language } = await Promise.race([s.final(), cancelledP]);
        const lang = normalizeLanguage(language);
        ctx.send({ type: "stt.final", turnId, text, words, ...(lang ? { language: lang } : {}) });

        const tAudioStart = ctx.tAudioStart();
        let pointing: PointingTarget[] = [];
        let error: string | undefined;
        if (tAudioStart === undefined) error = "no turn.audioStart received; pointing skipped";
        else pointing = resolvePointing(words, tAudioStart, ctx.cursorSamples(), { preMs: config.preMs, postMs: config.postMs }, languagesFor(config.language));
        const rests = computeRests(words, tAudioStart, ctx.cursorSamples(), pointing);
        ctx.mark("pointing.resolved", { targets: pointing.length, rests: rests.length });
        ctx.send({ type: "pointing.resolved", turnId, targets: pointing, rests });
        ctx.mark("turn.end");
        return {
          transcript: text, pointing, voiceText: "", solverText: "",
          usage: sttUsage(config.sttModel, audioBytes / 2 / SAMPLE_RATE), error,
        };
      } finally {
        s.close();
      }
    };

    return {
      onAudio(pcm) {
        if (cancelled) return;
        audioBytes += pcm.length;
        if (stt) stt.pushAudio(pcm);
        else pending.push(pcm);
      },
      onRelease: () => release(),
      cancel() {
        if (cancelled) return;
        cancelled = true;
        cancel(new Error("cancelled"));
        stt?.close();
      },
      done: run(),
    };
  };
}

export const cursorOnlyOrchestrator: Orchestrator = createCursorOnlyOrchestrator();
