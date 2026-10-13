// cursor-only approach (TASKS T9): Scribe STT + pointing resolution, no LLM, no TTS.
import { SAMPLE_RATE } from "../../shared/config.ts";
import { resolvePointing } from "../../shared/pointing.ts";
import type { PointingTarget } from "../../shared/protocol.ts";
import { openScribe } from "../adapters/scribe.ts";
import type { OpenScribe, SttStream } from "../adapters/types.ts";
import type { Orchestrator, TurnResult } from "./types.ts";

/** `open` is injectable for tests. */
export function createCursorOnlyOrchestrator(open: OpenScribe = openScribe): Orchestrator {
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
        s = await Promise.race([open({ mark: ctx.mark }), cancelledP]);
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
        const { text, words } = await Promise.race([s.final(), cancelledP]);
        ctx.send({ type: "stt.final", turnId, text, words });

        const tAudioStart = ctx.tAudioStart();
        let pointing: PointingTarget[] = [];
        let error: string | undefined;
        if (tAudioStart === undefined) error = "no turn.audioStart received; pointing skipped";
        else pointing = resolvePointing(words, tAudioStart, ctx.cursorSamples(), { preMs: config.preMs, postMs: config.postMs });
        ctx.mark("pointing.resolved", { targets: pointing.length });
        ctx.send({ type: "pointing.resolved", turnId, targets: pointing });
        ctx.mark("turn.end");
        return {
          transcript: text, pointing, voiceText: "", opusText: "",
          usage: { scribeSeconds: audioBytes / 2 / SAMPLE_RATE }, error,
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
