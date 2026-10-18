import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../shared/config.ts";
import { normalizeSelection, sttEngineOf } from "./speechEngines.ts";

describe("speech selection", () => {
  it("keeps known models and replaces unknown ones with the defaults", () => {
    expect(normalizeSelection({ tts: "kokoro", stt: "local_parakeet" })).toEqual({ tts: "kokoro", stt: "local_parakeet" });
    expect(normalizeSelection({ tts: "nope", stt: 3 })).toEqual({ tts: DEFAULT_CONFIG.ttsModel, stt: DEFAULT_CONFIG.sttModel });
    expect(normalizeSelection(null)).toEqual({ tts: DEFAULT_CONFIG.ttsModel, stt: DEFAULT_CONFIG.sttModel });
  });
  it("maps a local Speech model to its engine", () => {
    expect(sttEngineOf("local_whisperkit")).toBe("whisperkit");
    expect(sttEngineOf("scribe_v2")).toBeNull();
  });
});
