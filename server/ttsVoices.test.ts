import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PIPER_BASE, PIPER_CATALOG, piperVoices } from "./ttsVoices.ts";

let dir = "";
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function piperDir(voices: string[], speakers: Record<string, number> = {}): string {
  dir = mkdtempSync(join(tmpdir(), "piper-voices-"));
  const d = join(dir, "piper") + "/";
  mkdirSync(d);
  for (const v of voices) {
    writeFileSync(`${d}${v}.onnx`, "");
    writeFileSync(`${d}${v}.onnx.json`, JSON.stringify({ num_speakers: speakers[v] ?? 1 }));
  }
  return d;
}

describe("piperVoices", () => {
  it("nothing until Piper is installed", () => {
    expect(piperVoices("/nonexistent/")).toEqual([]);
  });

  it("the installed voices first (English, best quality first), then the catalog's others to download", () => {
    const list = piperVoices(piperDir(PIPER_BASE));
    expect(list.slice(0, 2)).toEqual([
      { id: "en_US-lessac-medium", lang: "en-US", label: "lessac (US, medium)", installed: true, default: true },
      { id: "ro_RO-mihai-medium", lang: "ro-RO", label: "mihai (RO, medium)", installed: true },
    ]);
    const more = list.slice(2);
    expect(more).toHaveLength(PIPER_CATALOG.length - 2);
    expect(more.every((v) => v.installed === false && v.bytes! > 0)).toBe(true);
    expect(more[0]?.label).toMatch(/high/);
  });

  it("a downloaded voice moves up, and lessac high becomes the default once it's there", () => {
    const list = piperVoices(piperDir([...PIPER_BASE, "en_US-lessac-high", "en_US-libritts_r-medium"], { "en_US-libritts_r-medium": 904 }));
    expect(list.filter((v) => v.installed).map((v) => v.id)).toEqual(["en_US-lessac-high", "en_US-lessac-medium", "en_US-libritts_r-medium", "ro_RO-mihai-medium"]);
    expect(list.find((v) => v.default)?.id).toBe("en_US-lessac-high");
    expect(list.find((v) => v.id === "en_US-libritts_r-medium")?.label).toBe("libritts r (US, medium, 904 speakers)");
  });

  it("an incomplete download (no .onnx yet) isn't listed as there", () => {
    const d = piperDir(PIPER_BASE);
    writeFileSync(`${d}en_US-ryan-high.onnx.json`, "{}");
    expect(piperVoices(d).find((v) => v.id === "en_US-ryan-high")?.installed).toBe(false);
  });

  it("the catalog's ids are valid voice ids (the install script maps them onto the voices repo)", () => {
    for (const v of PIPER_CATALOG) expect(v.id).toMatch(/^[a-z]{2,3}_[A-Z]{2}-[a-z0-9_]+-(x_low|low|medium|high)$/);
  });
});
