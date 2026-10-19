import { describe, expect, it } from "vitest";
import { cleanToggles, toggleOn } from "../../shared/config.ts";
import { claudeArgs, claudeEnv, codexConfig, describeAgent, grokArgs, grokEnv, opencodeSetup, rpcArgs, withoutTomlTables, type AgentSpec } from "./harnesses.ts";
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

describe("harness toggles", () => {
  const plugins = () => ["a@m", "b@m"];

  it("Claude Code: everything off is --safe-mode with skills off; part of the setup on turns the rest off one by one", () => {
    const off = claudeArgs(spec({}), plugins);
    expect(off).toEqual(expect.arrayContaining(["--safe-mode", "--strict-mcp-config", "--disable-slash-commands"]));
    expect(claudeEnv(spec({}))).toBe(process.env);
    const mcp = claudeArgs(spec({ toggles: { mcp: true } }), plugins);
    expect(mcp).not.toContain("--safe-mode");
    expect(mcp).not.toContain("--strict-mcp-config");
    expect(mcp).toContain("--disable-slash-commands");
    expect(JSON.parse(after(mcp, "--settings")!)).toEqual({ disableAllHooks: true, enabledPlugins: { "a@m": false, "b@m": false } });
    expect(claudeEnv(spec({ toggles: { mcp: true } }))).toMatchObject({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" });
    const all = claudeArgs(spec({ toggles: { mcp: true, skills: true, hooks: true, plugins: true, instructions: true } }), plugins);
    expect(all).not.toContain("--settings");
    expect(all).not.toContain("--disable-slash-commands");
  });

  it("Claude Code: tool toggles add to the solver's file tools", () => {
    const a = claudeArgs(spec({ role: "solver", project: "/p", toggles: { shell: true, web: true, subagents: true } }));
    expect(a.slice(a.indexOf("--tools") + 1, a.indexOf("--dangerously-skip-permissions")))
      .toEqual(["Read", "Edit", "Write", "Glob", "Grep", "Bash", "WebSearch", "WebFetch", "Agent"]);
  });

  it("Codex: each part that's off is turned off in the thread's config; the shell is on by default", () => {
    const off = codexConfig(spec({ harness: "codex" }), ["m1"]);
    expect(off).toMatchObject({
      web_search: "disabled", mcp_servers: { m1: { enabled: false } }, project_doc_max_bytes: 0,
      skills: { include_instructions: false, bundled: { enabled: false } },
      features: { hooks: false, plugins: false, multi_agent: false, image_generation: false },
    });
    expect((off.features as Record<string, boolean>).shell_tool).toBeUndefined();
    const on = codexConfig(spec({ harness: "codex", toggles: { shell: false, web: true, mcp: true, skills: true, hooks: true, plugins: true, instructions: true, subagents: true, images: true } }), ["m1"]);
    expect(on).toEqual({ features: { shell_tool: false, unified_exec: false } });
  });

  it("Grok: toggled tools come off the disallowed list; a Grok home of our own unless all of ~/.grok is on", () => {
    const off = grokArgs(spec({ harness: "grok" }), "hi");
    expect(off).toEqual(expect.arrayContaining(["--disable-web-search", "--no-subagents", "--system-prompt-override"]));
    expect(off.find((a) => a.startsWith("--disallowed-tools="))).toContain("run_terminal_command");
    const shell = grokArgs(spec({ harness: "grok", toggles: { shell: true, mcp: true } }), "hi");
    const disallowed = shell.find((a) => a.startsWith("--disallowed-tools="))!;
    expect(disallowed).not.toMatch(/run_terminal_command|search_tool|use_tool/);
    expect(shell).toContain("--rules");
    const env = grokEnv(spec({ harness: "grok", toggles: { skills: true } }), "/h");
    expect(env.GROK_HOME).toBe("/h/skills");
    expect(env.GROK_CLAUDE_SKILLS_ENABLED).toBeUndefined();
    expect(env.GROK_CLAUDE_HOOKS_ENABLED).toBe("0");
    expect(grokEnv(spec({ harness: "grok", toggles: { skills: true, hooks: true, plugins: true, mcp: true } }), "/h").GROK_HOME).toBe(process.env.GROK_HOME);
  });

  it("Grok: config.toml loses the tables of the parts that are off", () => {
    const toml = 'a = 1\n[plugins]\nenabled = ["x"]\n[mcp_servers.gh]\nurl = "u"\n[[marketplace.sources]]\nname = "n"\n';
    expect(withoutTomlTables(toml, ["plugins", "mcp_servers"])).toBe('a = 1\n[[marketplace.sources]]\nname = "n"\n');
  });

  it("opencode: per-message tools, and a --pure server unless plugins are on", () => {
    expect(describeAgent(spec({ harness: "opencode", toggles: { shell: true, skills: true } }))).toMatch(/^OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=true opencode serve --pure .*tools: bash,skill /);
    expect(opencodeSetup(spec({ harness: "opencode", toggles: { plugins: true, instructions: true } }))).toEqual({
      pure: false, env: { OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "true" },
    });
  });

  it("Pi and OhMyPi: discovery flags drop when toggled on; tools join the allowlist", () => {
    const pi = rpcArgs(spec({ harness: "pi", toggles: { shell: true, skills: true, plugins: true, instructions: true } }));
    expect(pi).not.toEqual(expect.arrayContaining(["--no-skills"]));
    expect(pi).not.toContain("--no-extensions");
    expect(pi).not.toContain("--no-context-files");
    expect(after(pi, "--tools")).toBe("bash");
    const omp = rpcArgs(spec({ harness: "omp", role: "solver", project: "/p", toggles: { web: true, subagents: true } }));
    expect(omp).toContain("--tools=read,edit,write,grep,glob,find,web_search,task");
    expect(omp).toEqual(expect.arrayContaining(["--no-extensions", "--no-skills", "--no-rules"]));
  });

  it("a toggle a harness doesn't list is off, and cleanToggles keeps only changes from the defaults", () => {
    expect(toggleOn("pi", { web: true }, "web")).toBe(false);
    expect(toggleOn("codex", undefined, "shell")).toBe(true);
    expect(cleanToggles("codex", { shell: true, web: true, images: false })).toEqual({ web: true });
    expect(cleanToggles("pi", { web: true })).toBeUndefined();
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
