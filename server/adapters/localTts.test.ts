import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { LOCAL_TTS_FILES, TTS_VENVS, openLocalTts, setLocalTtsLogger, startLocalTts, stopLocalTts } from "./localTts.ts";
import { SPEECH_ROOT } from "../paths.ts";
import { splitClauses } from "./sentences.ts";

describe("splitClauses", () => {
  it("keeps short sentences whole and splits long ones at clause boundaries (pieces ≥ min chars)", () => {
    expect(splitClauses("Let me check that.")).toEqual(["Let me check that."]);
    const long = "The grid keeps the three feature cards aligned in equal columns at every width, and lets the Embeds card span two columns.";
    expect(splitClauses(long)).toEqual([
      "The grid keeps the three feature cards aligned in equal columns at every width,",
      "and lets the Embeds card span two columns.",
    ]);
    // A tiny tail is merged into the previous piece.
    expect(splitClauses("First part of a fairly long sentence that keeps going on and on, ok.")).toEqual(["First part of a fairly long sentence that keeps going on and on, ok."]);
  });
});

describe("installed local TTS engines", () => {
  setLocalTtsLogger(() => {});
  afterEach(() => stopLocalTts());

  for (const engine of ["piper", "kokoro", "zonos3-mini"] as const) {
    const files = [`${TTS_VENVS[engine]}/bin/python`, ...LOCAL_TTS_FILES[engine].map((f) => `.models/${f}`)];
    it.skipIf(!files.every((f) => existsSync(SPEECH_ROOT + f)))(`${engine}: streams PCM16 24 kHz for English and Romanian, marks the first byte`, async () => {
      await startLocalTts(engine);
      for (const [language, text] of [["en", "Let me check that. It will be quick."], ["ro", "Mă uit la butonul ăsta."]] as const) {
        const marks: { name: string; meta?: Record<string, unknown> }[] = [];
        const tts = await openLocalTts(engine)({ mark: (name, meta) => marks.push({ name, meta }), voiceId: "", model: engine, segment: "answer", language });
        let bytes = 0;
        let audible = false;
        tts.onAudio((b) => {
          bytes += b.length;
          expect(b.length % 2).toBe(0);
          for (let i = 0; !audible && i < b.length; i += 2) audible = Math.abs(b.readInt16LE(i)) > 256;
        });
        for (const w of text.split(/(?<= )/)) tts.pushText(w);
        tts.flush();
        await tts.done();
        expect(bytes / 48000).toBeGreaterThan(0.8);
        expect(audible).toBe(true);
        expect(marks[0]).toMatchObject({ name: "answer.ttsFirstByte", meta: { model: engine } });
      }
    }, 60_000);
  }
});
