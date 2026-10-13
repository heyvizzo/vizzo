import { describe, expect, it } from "vitest";
import type { LlmPrompt } from "../../shared/protocol.ts";
import { fmtChars, promptAsText, promptSummary } from "./promptView.ts";

const p: LlmPrompt = {
  target: "router", model: "anthropic/claude-haiku-5.5",
  system: [{ label: "router.md", text: "x".repeat(4200), cached: true }],
  messages: [
    { role: "user", text: "What is this?", label: "earlier turn" },
    { role: "assistant", text: "The pricing table.", label: "earlier turn" },
    { role: "user", text: 'Transcript: "and this one?"\nClicked: <th> "Price / month"', label: "this turn" },
  ],
  tools: ["route"], toolChoice: "tool: route", settings: { output_config: { effort: "low" } },
};

describe("promptView", () => {
  it("summarizes the call", () => {
    expect(promptSummary(p)).toBe("Haiku router · anthropic/claude-haiku-5.5 · 3 messages · 4.3k chars");
    expect(fmtChars(950)).toBe("950 chars");
    expect(fmtChars(41_234)).toBe("41k chars");
  });
  it("copies as plain text with every part in order", () => {
    const t = promptAsText(p);
    expect(t.indexOf("## system · router.md (cached)")).toBeLessThan(t.indexOf("## user · earlier turn"));
    expect(t).toContain("tool_choice tool: route");
    expect(t.trimEnd().endsWith('Clicked: <th> "Price / month"')).toBe(true);
  });
});

describe("response view", () => {
  it("summarizes Anthropic usage (cache read/write) and OpenAI Realtime usage (cached, audio)", async () => {
    const { responseSummary, usageSummary, responseBadge } = await import("./promptView.ts");
    expect(usageSummary({ input_tokens: 182, output_tokens: 816, cache_read_input_tokens: 9215, cache_creation_input_tokens: 0 })).toBe("in 182 (cache read 9,215) · out 816");
    expect(usageSummary({ input_tokens: 1003, output_tokens: 202, input_token_details: { cached_tokens: 960, audio_tokens: 38 }, output_token_details: { audio_tokens: 120 } }))
      .toBe("in 1,003 (cache read 960, audio 38) · out 202 (audio 120)");
    expect(usageSummary(null)).toBe("");
    const r = { target: "opus" as const, stopReason: "end_turn", usage: { input_tokens: 182, output_tokens: 816 }, durationMs: 7748 };
    expect(responseSummary(r)).toBe("↳ response · stop: end_turn · in 182 · out 816 · 7.7 s");
    expect(responseSummary({ target: "router", error: "529 overloaded", durationMs: 300 })).toBe("↳ error · 529 overloaded · 0.3 s");
    expect(responseBadge({ target: "realtime", label: "answer", stopReason: "completed", durationMs: 2100 })).toBe("✓ answer completed 2.1 s");
  });
});
