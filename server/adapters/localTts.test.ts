import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { openLocalTts, setLocalTtsLogger, startLocalTts, stopLocalTts } from "./localTts.ts";
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

const root = fileURLToPath(new URL("../../", import.meta.url));
const installed = existsSync(`${root}.venv-tts/bin/python`) && existsSync(`${root}.models/kokoro/kokoro-v1.0.onnx`) && existsSync(`${root}.models/piper/ro_RO-mihai-medium.onnx`);

describe.skipIf(!installed)("local engines: Kokoro and Piper (npm run setup:local-tts)", () => {
  setLocalTtsLogger(() => {});
  afterAll(() => stopLocalTts());

  for (const engine of ["piper", "kokoro"] as const) {
    it(`${engine}: streams PCM16 24 kHz for English and Romanian, marks the first byte`, async () => {
      await startLocalTts(engine);
      for (const [language, text] of [["en", "Let me check that. It will be quick."], ["ro", "Mă uit la butonul ăsta."]] as const) {
        const marks: { name: string; meta?: Record<string, unknown> }[] = [];
        const tts = await openLocalTts(engine)({ mark: (name, meta) => marks.push({ name, meta }), voiceId: "", model: engine, segment: "answer", language });
        let bytes = 0;
        tts.onAudio((b) => { bytes += b.length; expect(b.length % 2).toBe(0); });
        for (const w of text.split(/(?<= )/)) tts.pushText(w);
        tts.flush();
        await tts.done();
        expect(bytes / 48000).toBeGreaterThan(0.8);
        expect(marks[0]).toMatchObject({ name: "answer.ttsFirstByte", meta: { model: engine } });
      }
    }, 60_000);
  }
});
