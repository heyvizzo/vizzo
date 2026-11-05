import { describe, expect, it } from "vitest";
import type { InstallState } from "../../shared/protocol.ts";
import { STT_ROWS, TTS_ROWS, canSelect, installView, rowNotes, voiceNotes, type ModelRow, type RowContext } from "./speechModels.ts";

const row = (id: string): ModelRow => [...STT_ROWS, ...TTS_ROWS].find((r) => r.id === id)!;
const ctx = (over: Partial<RowContext> = {}): RowContext => ({ selected: false, env: {}, language: "auto", engines: [], pending: false, ...over });
const label = (key: string) => ({ OPENROUTER_API_KEY: "OpenRouter API key", ELEVENLABS_API_KEY: "ElevenLabs API key" })[key] ?? key;
const inst = (over: Partial<InstallState>): InstallState => ({ kind: "stt", engine: "parakeet", installed: false, state: "idle", ...over });

describe("speech model rows", () => {
  it("lists every model once, API ones with a key and on-device ones with an engine", () => {
    const ids = [...STT_ROWS, ...TTS_ROWS].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of [...STT_ROWS, ...TTS_ROWS]) {
      if (r.group === "api") expect(r.apiKey, r.id).toBeTruthy();
      else expect(r.engine, r.id).toBeTruthy();
    }
    expect(row("local_parakeet").engine).toBe("parakeet");
  });

  it("flags a missing API key, pointing at its field", () => {
    expect(rowNotes(row("openrouter_whisper_large_v3"), ctx(), label)).toEqual([
      { tone: "error", text: "OpenRouter API key is missing. Add it under API keys.", focus: "OPENROUTER_API_KEY" },
    ]);
    expect(rowNotes(row("openrouter_whisper_large_v3"), ctx({ env: { OPENROUTER_API_KEY: "sk" } }), label)).toEqual([]);
    expect(rowNotes(row("fish_drama_3"), ctx({ env: { OPENROUTER_API_KEY: "  " } }), label)[0]?.focus).toBe("OPENROUTER_API_KEY");
  });

  it("ElevenLabs speech also needs a voice ID", () => {
    const notes = rowNotes(row("eleven_flash_v2_5"), ctx({ env: { ELEVENLABS_API_KEY: "k" } }), label);
    expect(notes).toEqual([{ tone: "error", text: "Needs a voice ID.", focus: "ELEVENLABS_VOICE_ID" }]);
  });

  it("warns about a speech model that won't follow the pinned language", () => {
    const notes = rowNotes(row("local_moonshine"), ctx({ language: "ro", install: inst({ engine: "moonshine", installed: true }) }), label);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ tone: "warn" });
    expect(notes[0]?.text).toContain("Romanian");
  });

  it("says a selected on-device model isn't installed, and a failed install's error", () => {
    expect(rowNotes(row("local_parakeet"), ctx({ selected: true, install: inst({}) }), label)[0]?.text).toMatch(/Not installed/);
    expect(rowNotes(row("local_parakeet"), ctx({ selected: false, install: inst({}) }), label)).toEqual([]);
    expect(rowNotes(row("local_parakeet"), ctx({ install: inst({ state: "error", error: "uv is required" }) }), label)[0])
      .toEqual({ tone: "error", text: "Install failed: uv is required" });
  });

  it("says what an install is doing, in full", () => {
    expect(rowNotes(row("local_whisperkit"), ctx({ install: inst({ engine: "whisperkit", state: "installing", phase: "Compiling for the Neural Engine (a few minutes)" }) }), label))
      .toEqual([{ tone: "loading", text: "Compiling for the Neural Engine (a few minutes)" }]);
  });

  it("shows the selected installed engine loading or loaded", () => {
    const loading = rowNotes(row("local_parakeet"), ctx({ selected: true, install: inst({ installed: true }), pending: true }), label);
    expect(loading[0]).toMatchObject({ tone: "loading" });
    const ready = rowNotes(row("local_parakeet"), ctx({
      selected: true, install: inst({ installed: true }),
      engines: [{ kind: "stt", engine: "parakeet", label: "Parakeet", state: "ready", loadMs: 1200 }],
    }), label);
    expect(ready[0]).toEqual({ tone: "ok", text: "Parakeet loaded in 1.2 s" });
  });
});

describe("installView", () => {
  const p = row("local_parakeet");
  it("is only for on-device rows", () => {
    expect(installView(row("scribe_v2"), undefined)).toBeNull();
  });
  it("says what to do while the voice server isn't running", () => {
    expect(installView(p, undefined)).toEqual({ text: "Waiting for the voice server…" });
  });
  it("built in: no button", () => {
    expect(installView(row("local_apple"), inst({ engine: "apple", builtin: true, installed: true }))).toEqual({ text: "Built into macOS" });
  });
  it("Install with the download size, Cancel while waiting or installing, Uninstall with the size on disk", () => {
    expect(installView(p, inst({ downloadBytes: 2.5 * 1024 ** 3 }))).toEqual({ button: "install", text: "2.5 GB download" });
    expect(installView(p, inst({ state: "queued" }))).toEqual({ button: "cancel", text: "Waiting for another install…" });
    expect(installView(p, inst({ state: "installing", phase: "Downloading Parakeet", progress: 0.42, totalBytes: 2.3 * 1024 ** 3 })))
      .toEqual({ button: "cancel", text: "42% of 2.3 GB", progress: 0.42 });
    expect(installView(p, inst({ state: "installing", phase: "Compiling for the Neural Engine" })))
      .toEqual({ button: "cancel", text: "Working…", busy: true });
    expect(installView(p, inst({ installed: true, diskBytes: 300 * 1024 ** 2 }))).toEqual({ button: "uninstall", text: "300 MB" });
    expect(installView(p, inst({ state: "error", error: "x" }))).toMatchObject({ button: "install" });
  });
});

describe("canSelect", () => {
  it("an on-device model must be installed first, unless it's already the pick", () => {
    const p = row("local_parakeet");
    expect(canSelect(p, inst({}), false)).toBe(false);
    expect(canSelect(p, inst({}), true)).toBe(true);
    expect(canSelect(p, inst({ installed: true }), false)).toBe(true);
    expect(canSelect(row("scribe_v2"), undefined, false)).toBe(true);
  });
});

describe("voiceNotes", () => {
  it("says which picked voices are downloading, waiting or failed", () => {
    const label = (v: string) => `${v} (US, high)`;
    expect(voiceNotes(undefined, label)).toEqual([]);
    expect(voiceNotes(inst({ engine: "piper", installed: true, voices: [
      { voice: "ryan", state: "installing", progress: 0.4 },
      { voice: "amy", state: "queued" },
      { voice: "cori", state: "error", error: "404" },
    ] }), label)).toEqual([
      { tone: "loading", text: "Downloading ryan (US, high) · 40%. It's used once it's here." },
      { tone: "loading", text: "Waiting to download amy (US, high)…" },
      { tone: "error", text: "Couldn't download cori (US, high): 404" },
    ]);
  });
});
