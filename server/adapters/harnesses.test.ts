import { describe, expect, it } from "vitest";
import { claudeArgs, describeAgent, rpcArgs, type AgentSpec } from "./harnesses.ts";
import { parseOpencodeVerbose, scanHarnesses } from "../llmProviders.ts";

const spec = (o: Partial<AgentSpec>): AgentSpec => ({ role: "router", harness: "claude-code", model: "claude-haiku-5-5", system: "SYS", ...o });
const after = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

describe("harness command lines", () => {
  it("Claude Code: yolo, no tools for the router, effort, fast mode through settings", () => {
    const a = claudeArgs(spec({ level: "low" }));
    expect(a).toContain("--dangerously-skip-permissions");
    expect(after(a, "--tools")).toBe("");
    expect(after(a, "--effort")).toBe("low");
    expect(a).not.toContain("--settings");
    expect(after(a, "--system-prompt")).toBe("SYS");
    const o = claudeArgs(spec({ role: "solver", model: "claude-opus-5-5", level: "max", speed: "fast", project: "/p" }));
    expect(o.slice(o.indexOf("--tools") + 1, o.indexOf("--tools") + 6)).toEqual(["Read", "Edit", "Write", "Glob", "Grep"]);
    expect(o).toContain("Read(.env*)");
    expect(JSON.parse(after(o, "--settings")!)).toEqual({ fastMode: true });
    expect(o).not.toContain("--restricted"); // it refuses bypass mode
  });

  it("Claude Code: no model flag for the default model, no effort flag without a level", () => {
    const a = claudeArgs(spec({ model: "" }));
    expect(a).not.toContain("--model");
    expect(a).not.toContain("--effort");
  });

  it("Pi: thinking level, no tools for the router, file tools in the project", () => {
    const a = rpcArgs(spec({ harness: "pi", model: "openrouter/google/gemini-3.8-flash", level: "minimal" }));
    expect(a.slice(0, 3)).toEqual(["--mode", "rpc", "--no-session"]);
    expect(after(a, "--thinking")).toBe("minimal");
    expect(a).toContain("--no-tools");
    const o = rpcArgs(spec({ harness: "pi", role: "solver", model: "", project: "/p" }));
    expect(after(o, "--tools")).toBe("read,edit,write,grep,find,ls");
    expect(o).not.toContain("--model");
  });

  it("OhMyPi: yolo approvals, priority service tier for fast", () => {
    const a = rpcArgs(spec({ harness: "omp", model: "openai-codex/gpt-6-astra", level: "high", speed: "fast" }));
    expect(a).toContain("--approval-mode=yolo");
    expect(after(a, "--service-tier")).toBe("priority");
    expect(after(a, "--thinking")).toBe("high");
    expect(rpcArgs(spec({ harness: "omp", model: "x/y" }))).not.toContain("--service-tier");
  });

  it("describes Codex and opencode runs for the prompt inspector", () => {
    expect(describeAgent(spec({ harness: "codex", model: "gpt-6-astra", level: "low", speed: "fast" })))
      .toMatch(/serviceTier: priority, sandbox: danger-full-access, approvalPolicy: never, baseInstructions.*effort: low/);
    expect(describeAgent(spec({ harness: "codex", role: "solver", model: "gpt-6.1-sol", project: "/p" }))).toContain("developerInstructions");
    expect(describeAgent(spec({ harness: "opencode", model: "cerebras/gpt-oss-120b", level: "low" }))).toMatch(/variant: low.*tools: none.*allow all/);
    expect(describeAgent(spec({ harness: "grok", model: "grok-4.7", level: "medium" }))).toMatch(/--reasoning-effort medium --always-approve/);
  });
});

describe("opencode model list", () => {
  it("reads each model's variants as its levels", () => {
    const out = [
      "opencode/claude-opus-5-5", "{", '  "id": "claude-opus-5-5",', '  "variants": {', '    "low": {', '      "effort": "low"', "    },", '    "max": {}', "  }", "}",
      "cerebras/gpt-oss-120b", "{", '  "id": "gpt-oss-120b"', "}",
    ].join("\n");
    expect(parseOpencodeVerbose(out)).toEqual([
      { id: "opencode/claude-opus-5-5", levels: ["low", "max"], fast: false },
      { id: "cerebras/gpt-oss-120b", levels: [], fast: false },
    ]);
  });
});

describe("scan harnesses", () => {
  it("lists each installed harness's models; a failing one gets its error, a missing one its install note", async () => {
    const opus = { id: "claude-opus-5-5", levels: ["low", "max"], fast: true };
    const scan = await scanHarnesses(
      () => [
        { id: "claude-code", label: "Claude Code", available: true },
        { id: "grok", label: "Grok", available: true },
        { id: "pi", label: "Pi", available: false, note: "not installed" },
      ],
      async (id) => { if (id === "grok") throw new Error("no model list within 20 s"); return [opus]; },
    );
    expect(scan).toEqual([
      { id: "claude-code", label: "Claude Code", available: true, models: [opus] },
      { id: "grok", label: "Grok", available: true, models: [], error: "no model list within 20 s" },
      { id: "pi", label: "Pi", available: false, note: "not installed", models: [] },
    ]);
  });
});
