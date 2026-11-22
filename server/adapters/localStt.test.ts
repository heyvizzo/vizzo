import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { languageCode } from "../../shared/languages.ts";
import { createInstaller } from "../speechInstall.ts";
import { openLocalStt, setLocalSttLogger, startLocalStt, stopLocalStt, transcriptScore, whisperKitAmong, WHISPERKIT_MODEL_DIR } from "./localStt.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const mac = process.platform === "darwin";
const py = existsSync(`${root}.venv-stt/bin/python`);
const installed = {
  parakeet: mac && py && existsSync(`${root}.models/parakeet`),
  moonshine: mac && py && existsSync(`${root}.models/moonshine`),
  apple: mac,
  whisperkit: mac && existsSync(WHISPERKIT_MODEL_DIR),
  "rumble-2-flash": mac && createInstaller().states().some((s) => s.kind === "stt" && s.engine === "rumble-2-flash" && s.installed),
};

/** A spoken clip from macOS `say`, as PCM16 mono 24 kHz (the WAV's data chunk). */
function sayPcm(text: string, voice?: string): Buffer {
  const file = join(mkdtempSync(join(tmpdir(), "localstt-")), "clip.wav");
  execFileSync("say", [...(voice ? ["-v", voice] : []), "-o", file, "--data-format=LEI16@24000", text]);
  const wav = readFileSync(file);
  const at = wav.indexOf("data", 12);
  return wav.subarray(at + 8, at + 8 + wav.readUInt32LE(at + 4));
}

describe("WhisperKit among the languages you speak", () => {
  const result = (score: number, text = "x") => ({ text, words: [], score });

  it("scores a transcript by its segments' log-probability, weighted by duration", () => {
    expect(transcriptScore([{ start: 0, end: 3, avg_logprob: -0.1 }, { start: 3, end: 4, avg_logprob: -0.5 }])).toBeCloseTo(-0.2);
    expect(transcriptScore([])).toBe(-Infinity);
    expect(transcriptScore(undefined)).toBe(-Infinity);
  });

  it("transcribes in each language and keeps the most confident", async () => {
    const scores: Record<string, number> = { en: -0.7, ro: -0.4, de: -0.9 };
    const r = await whisperKitAmong(["en", "ro", "de"], async (l) => result(scores[l]!));
    expect(r.language).toBe("ro");
    expect(r.tried).toEqual(scores);
  });

  it("stops at silence", async () => {
    const tried: string[] = [];
    await whisperKitAmong(["en", "ro"], async (l) => { tried.push(l); return result(-Infinity, ""); });
    expect(tried).toEqual(["en"]);
  });
});

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

  it.skipIf(!installed["rumble-2-flash"])("rumble-2-flash: auto-detects English and transcribes pinned Romanian on commit", async () => {
    for (const { audio, language, expectedLanguage, word } of [
      { audio: pcm, language: undefined, expectedLanguage: "en", word: "button" },
      { audio: sayPcm("Poți să faci butonul acesta mai mare?", "Ioana"), language: "ro", expectedLanguage: "ro", word: "butonul" },
    ]) {
      const stt = await openLocalStt("rumble-2-flash")({ mark: () => {}, language });
      try {
        const partials: string[] = [];
        stt.onPartial((text) => partials.push(text));
        for (let i = 0; i < audio.length; i += 4800) stt.pushAudio(audio.subarray(i, i + 4800));
        stt.commit();
        const final = await stt.final();
        expect(final.text.toLowerCase()).toContain(word);
        expect(languageCode(final.language)).toBe(expectedLanguage);
        expect(final.words).toEqual([]);
        expect(partials).toEqual([]);
      } finally {
        stt.close();
      }
    }
  }, 120_000);

  /** Transcribe a clip with the engine; the final transcript and the stt.final mark's data. */
  async function transcribe(engine: "whisperkit" | "rumble-2-flash", audio: Buffer, opts: { language?: string; languages?: string[] }) {
    let mark: Record<string, unknown> = {};
    const stt = await openLocalStt(engine)({ mark: (name, data) => { if (name === "stt.final") mark = data ?? {}; }, ...opts });
    try {
      stt.pushAudio(audio);
      stt.commit();
      return { ...(await stt.final()), mark };
    } finally {
      stt.close();
    }
  }
  const english = mac ? sayPcm("Move this button a little to the right") : Buffer.alloc(0);
  const romanian = mac ? sayPcm("Mută butonul ăsta puțin mai la dreapta", "Ioana") : Buffer.alloc(0);

  it.skipIf(!installed.whisperkit)("whisperkit: follows a pinned language (restarting its server for it) and picks among several", async () => {
    // Pinned to English, this Romanian question comes out in English: the pin is followed (it used to be ignored).
    expect((await transcribe("whisperkit", sayPcm("Ce face asta aici?", "Ioana"), { language: "en" })).text.toLowerCase()).not.toContain("asta");
    for (const [audio, language, word] of [[romanian, "ro", "butonul"], [english, "en", "button"]] as const) {
      const r = await transcribe("whisperkit", audio, { languages: ["en", "ro"] });
      expect(languageCode(r.language)).toBe(language);
      expect(r.text.toLowerCase()).toContain(word);
      expect(r.mark.among).toEqual(["en", "ro"]);
      expect(Object.keys(r.mark.tried as object)).toEqual(["en", "ro"]);
    }
    // Back to Auto: detects again.
    expect(languageCode((await transcribe("whisperkit", romanian, {})).language)).toBe("ro");
  }, 180_000);

  it.skipIf(!installed["rumble-2-flash"])("rumble-2-flash: detects only among the languages you speak", async () => {
    // A lone "Da" is heard as Russian "Да" on its own; among Romanian and English it's Romanian.
    const r = await transcribe("rumble-2-flash", sayPcm("Da", "Ioana"), { languages: ["ro", "en"] });
    expect(languageCode(r.language)).toBe("ro");
    expect(r.text).toMatch(/^Da/);
    expect(languageCode((await transcribe("rumble-2-flash", romanian, { languages: ["en", "fi"] })).language)).not.toBe("ro");
  }, 120_000);

  it.skipIf(!installed.moonshine)("close() rejects a pending final", async () => {
    const stt = await openLocalStt("moonshine")({ mark: () => {} });
    stt.pushAudio(pcm.subarray(0, 4800));
    const final = stt.final();
    stt.close();
    await expect(final).rejects.toThrow(/closed before final/);
  }, 120_000);
});
