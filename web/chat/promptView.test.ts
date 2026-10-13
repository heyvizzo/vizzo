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
