import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../shared/config.ts";
import { firstRunChoice } from "./llmSelection.ts";

const levels = ["low", "medium", "high"];

describe("firstRunChoice", () => {
  it("uses Claude Code's defaults when it's installed", () => {
    const sel = firstRunChoice([
      { id: "claude-code", available: true, models: [] },
      { id: "codex", available: true, models: [] },
    ]);
    expect(sel).toEqual(DEFAULT_CONFIG.llm);
    expect(sel.fast).toEqual({ provider: "claude-code", model: "claude-haiku-5-5", level: "low" });
    expect(sel.smart).toEqual({ provider: "claude-code", model: "claude-opus-5-5", level: "medium" });
  });

  it("falls back to the first installed harness with its default models and levels", () => {
    const sel = firstRunChoice([
      { id: "claude-code", available: false, models: [] },
      { id: "codex", available: true, models: [{ id: "gpt-6-luna", levels, fast: false }, { id: "gpt-6.1-sol", levels, fast: false }] },
      { id: "grok", available: true, models: [] },
    ]);
    expect(sel).toEqual({
      fast: { provider: "codex", model: "gpt-6-luna", level: "low" },
      smart: { provider: "codex", model: "gpt-6.1-sol", level: "medium" },
    });
  });

  it("uses the harness's own default model when its list lacks ours", () => {
    const sel = firstRunChoice([{ id: "pi", available: true, models: [{ id: "x/y", levels: [], fast: false }] }]);
    expect(sel).toEqual({ fast: { provider: "pi", model: "" }, smart: { provider: "pi", model: "" } });
  });

  it("ignores model APIs and keeps the defaults when nothing is installed", () => {
    expect(firstRunChoice([{ id: "openrouter", available: true, api: true, models: [] }])).toEqual(DEFAULT_CONFIG.llm);
  });
});
