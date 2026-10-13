import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { agentStatus, cliRequest, poolSizes, registerCliSpecs, setCliLogger, startClaudeAgents, stopClaudeAgents } from "./claudeCli.ts";
import { cliUserMessage, extractJsonObject } from "./claude.ts";

const FAKE = fileURLToPath(new URL("./__fixtures__/fake-claude.mjs", import.meta.url));
const until = async (f: () => boolean, ms = 5000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 20)); } };

setCliLogger(() => {});
beforeEach(() => registerCliSpecs(() => ({
  router: { model: "claude-haiku-5-5", effort: "low", system: () => "ROUTER system" },
  fillers: { model: "claude-haiku-5-5", effort: "low", system: () => "FILLERS system" },
  opus: { model: "claude-opus-5-5", effort: "medium", system: () => "OPUS system" },
})));
afterEach(() => stopClaudeAgents());

describe("claude -p agent pool", () => {
  it("keeps one agent waiting per role and replaces it as soon as it's taken", async () => {
    startClaudeAgents({ bin: FAKE, sizes: { router: 1, fillers: 1, opus: 1 } });
    expect(agentStatus()).toEqual({ router: 1, fillers: 1, opus: 1 });
    const deltas: string[] = [];
    const r = await cliRequest("router", "hello there", { onText: (d) => deltas.push(d) });
    expect(r.text).toBe("ROUTER: hello there");
    expect(deltas.join("")).toBe(r.text);
    expect(deltas.length).toBeGreaterThan(1); // streamed in chunks
    expect(r).toMatchObject({ stopReason: "end_turn", model: "claude-haiku-5-5", usage: { input_tokens: 10, output_tokens: 5 }, cliCostUsd: 0.0001 });
    await until(() => agentStatus().router === 1); // replacement already waiting
    const o = await cliRequest("opus", "why grid?");
    expect(o.text).toBe("OPUS: why grid?");
  });

  it("spawns a cold agent when none is waiting (pool size 0)", async () => {
    startClaudeAgents({ bin: FAKE, sizes: { router: 0, fillers: 0, opus: 0 } });
    expect(agentStatus().router).toBe(0);
    const r = await cliRequest("fillers", "x");
    expect(r.warm).toBe(false);
    expect(r.text).toBe("FILLERS: x");
  });

  it("parses CLAUDE_AGENTS sizes", () => {
    expect(poolSizes("router:2, opus:3")).toEqual({ router: 2, fillers: 1, opus: 3 });
    expect(poolSizes(undefined)).toEqual({ router: 1, fillers: 1, opus: 1 });
  });
});

describe("CLI request shaping", () => {
  it("flattens earlier turns into one user message; extracts the JSON object from fenced text", () => {
    const msg = cliUserMessage({ model: "m", messages: [
      { role: "user", content: "What is this?" }, { role: "assistant", content: "The pricing table." }, { role: "user", content: "Transcript: \"and that?\"" },
    ] });
    expect(msg).toBe('Conversation so far (oldest first):\n\nUser: What is this?\n\nAssistant: The pricing table.\n\n---\n\nThis turn:\nTranscript: "and that?"');
    expect(cliUserMessage({ model: "m", messages: [{ role: "user", content: "only" }] })).toBe("only");
    expect(extractJsonObject('```json\n{"intent":"clarify","say":"Which one?"}\n```')).toBe('{"intent":"clarify","say":"Which one?"}');
    expect(extractJsonObject("no json")).toBeNull();
  });
});
