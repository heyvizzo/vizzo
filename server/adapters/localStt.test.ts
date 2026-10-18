import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { openLocalStt, setLocalSttLogger, startLocalStt, stopLocalStt, WHISPERKIT_MODEL_DIR, type LocalSttEngine } from "./localStt.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const mac = process.platform === "darwin";
const py = existsSync(`${root}.venv-stt/bin/python`);
const installed: Record<LocalSttEngine, boolean> = {
  parakeet: mac && py && existsSync(`${root}.models/parakeet`),
  moonshine: mac && py && existsSync(`${root}.models/moonshine`),
  apple: mac,
  whisperkit: mac && existsSync(WHISPERKIT_MODEL_DIR),
};

/** A spoken clip from macOS `say`, as PCM16 mono 24 kHz (the WAV's data chunk). */
function sayPcm(text: string, voice?: string): Buffer {
  const file = join(mkdtempSync(join(tmpdir(), "localstt-")), "clip.wav");
  execFileSync("say", [...(voice ? ["-v", voice] : []), "-o", file, "--data-format=LEI16@24000", text]);
  const wav = readFileSync(file);
  const at = wav.indexOf("data", 12);
  return wav.subarray(at + 8, at + 8 + wav.readUInt32LE(at + 4));
}

describe.skipIf(!mac)("on-device STT engines (npm run setup:local-stt)", () => {
  setLocalSttLogger(() => {});
  afterAll(() => stopLocalStt());
  const pcm = mac ? sayPcm("Can you make this button bigger and move that header over here?") : Buffer.alloc(0);

  for (const engine of ["parakeet", "apple", "whisperkit", "moonshine"] as const) {
    it.skipIf(!installed[engine])(`${engine}: transcribes with word timings in seconds from the first sample`, async () => {
      await startLocalStt(engine);
      const marks: string[] = [];
      const partials: string[] = [];
      const stt = await openLocalStt(engine)({ mark: (name) => marks.push(name), language: "en" });
      stt.onPartial((t) => partials.push(t));
      for (let i = 0; i < pcm.length; i += 4800) stt.pushAudio(pcm.subarray(i, i + 4800));
      stt.commit();
      const { text, words } = await stt.final();
      stt.close();
      expect(text.toLowerCase()).toContain("button");
      expect(words.map((w) => w.text.toLowerCase().replace(/[^a-z]/g, ""))).toContain("button");
      for (const [i, w] of words.entries()) {
        expect(w.end).toBeGreaterThanOrEqual(w.start);
        if (i) expect(w.start).toBeGreaterThanOrEqual(words[i - 1]!.start);
      }
      expect(words.at(-1)!.end).toBeLessThan(pcm.length / 48000 + 0.5);
      expect(stt.seconds).toBeCloseTo(pcm.length / 48000, 3);
      expect(marks).toContain("stt.final");
    }, 120_000);
  }

  it.skipIf(!installed.parakeet)("parakeet: Romanian", async () => {
    const stt = await openLocalStt("parakeet")({ mark: () => {}, language: "ro" });
    stt.pushAudio(sayPcm("Poți să faci butonul acesta mai mare?", "Ioana"));
    stt.commit();
    expect((await stt.final()).text.toLowerCase()).toContain("butonul");
  }, 120_000);

  it.skipIf(!installed.moonshine)("close() rejects a pending final", async () => {
    const stt = await openLocalStt("moonshine")({ mark: () => {} });
    stt.pushAudio(pcm.subarray(0, 4800));
    const final = stt.final();
    stt.close();
    await expect(final).rejects.toThrow(/closed before final/);
  }, 120_000);
});
