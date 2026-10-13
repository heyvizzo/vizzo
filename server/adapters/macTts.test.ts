import { execSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { openMacTts, setMacTtsLogger, startMacTts, stopMacTts, takeSentences } from "./macTts.ts";

describe("takeSentences", () => {
  it("splits off complete sentences and keeps the rest", () => {
    expect(takeSentences("Let me check. The grid ")).toEqual([["Let me check."], "The grid "]);
    expect(takeSentences("Is it? Yes! Done")).toEqual([["Is it?", "Yes!"], "Done"]);
    // a sentence end at the very end may still be "3.5" or "e.g." — wait for more text (or flush)
    expect(takeSentences("Version 3.")).toEqual([[], "Version 3."]);
    expect(takeSentences("")).toEqual([[], ""]);
  });
});

const hasSwift = (() => { try { execSync("command -v swiftc", { stdio: "ignore" }); return process.platform === "darwin"; } catch { return false; } })();

describe.skipIf(!hasSwift)("on-device TTS helper (macOS)", () => {
  setMacTtsLogger(() => {});
  afterAll(() => stopMacTts());

  it("streams PCM16 24 kHz for English and Romanian, marks the first byte", async () => {
    await startMacTts();
    for (const [language, text] of [["en", "Let me check that. It will be quick."], ["ro", "Mă uit la butonul ăsta."]] as const) {
      const marks: { name: string; meta?: Record<string, unknown> }[] = [];
      const tts = await openMacTts({ mark: (name, meta) => marks.push({ name, meta }), voiceId: "", model: "macos", segment: "ack", language });
      let bytes = 0;
      tts.onAudio((b) => { bytes += b.length; expect(b.length % 2).toBe(0); });
      for (const w of text.split(/(?<= )/)) tts.pushText(w);
      tts.flush();
      await tts.done();
      expect(bytes / 48000).toBeGreaterThan(0.8); // seconds of audio
      expect(marks[0]).toMatchObject({ name: "ack.ttsFirstByte", meta: { model: "macos" } });
      expect(tts.chars).toBe(text.length);
    }
  }, 60_000);
});
