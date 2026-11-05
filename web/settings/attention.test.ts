import { describe, expect, it } from "vitest";
import { keyProblems, permissionProblems, sortProblems, speechProblems, speechStatusOf, tierProblems, verdict, type Problem } from "./attention.ts";

const ctx = { env: {}, language: "auto" as const, engines: [], pending: false };

describe("attention", () => {
  it("flags a tier whose harness isn't installed", () => {
    const p = tierProblems("smart", { provider: "claude-code", model: "claude-opus-5-5" }, [
      { id: "claude-code", label: "Claude Code", available: false, note: "not installed" },
    ]);
    expect(p).toEqual([{ tone: "bad", text: "Smart tier: Claude Code isn't installed (not installed).", section: "models" }]);
    expect(tierProblems("fast", { provider: "claude-code", model: "" }, [{ id: "claude-code", label: "Claude Code", available: true }])).toEqual([]);
  });

  it("flags an API speech model without its key, pointing at the key", () => {
    const st = speechStatusOf("tts", "openai_tts_1", ctx, () => "OpenAI API key");
    expect(speechProblems("tts", st)).toEqual([
      { tone: "bad", text: "Text to speech (OpenAI tts-1): OpenAI API key is missing. Add it under API keys.", section: "tts", focusKey: "OPENAI_API_KEY" },
    ]);
    expect(speechProblems("tts", speechStatusOf("tts", "openai_tts_1", { ...ctx, env: { OPENAI_API_KEY: "1" } }, (k) => k))).toEqual([]);
  });

  it("is quiet for the built-in macOS engines once they're ready", () => {
    const installs = [{ kind: "stt" as const, engine: "apple", builtin: true, installed: true, state: "idle" as const }];
    const engines = [{ kind: "stt" as const, engine: "apple", state: "ready" as const }];
    expect(speechProblems("stt", speechStatusOf("stt", "local_apple", { ...ctx, engines, installs } as never, (k) => k))).toEqual([]);
  });

  it("counts only required permissions and orders failures first", () => {
    const rows = [
      { id: "microphone", name: "Microphone", ok: false, summary: "Not allowed", instruction: "Allow it." },
      { id: "chrome-keychain", name: "Chrome keychain", ok: false, optional: true, summary: "Not found", instruction: "Open Chrome." },
    ];
    const problems: Problem[] = [{ tone: "warn", text: "w", section: "stt" }, { tone: "busy", text: "b", section: "tts" }, ...permissionProblems(rows), ...keyProblems(["X"], () => "X key")];
    expect(sortProblems(problems).map((p) => p.tone)).toEqual(["bad", "bad", "busy", "warn"]);
    expect(verdict(problems)).toEqual({ tone: "bad", title: "2 things need attention" });
    expect(verdict([{ tone: "busy", text: "b", section: "tts" }])).toEqual({ tone: "busy", title: "Starting up…" });
    expect(verdict([])).toEqual({ tone: "ok", title: "Everything works" });
  });
});
