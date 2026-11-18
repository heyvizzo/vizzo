import { describe, expect, it } from "vitest";
import { cleanToggles, toggleOn } from "../../shared/config.ts";
import { claudeArgs, claudeEnv, claudeSessionArgs, codexConfig, describeAgent, grokArgs, grokDisallowed, grokEnv, opencodeSetup, rpcArgs, withoutTomlTables, type AgentSpec } from "./harnesses.ts";
import { parseOpencodeVerbose, scanHarnesses } from "../llmProviders.ts";

const spec = (o: Partial<AgentSpec>): AgentSpec => ({ role: "router", harness: "claude-code", model: "claude-haiku-5-5", system: "SYS", ...o });
const after = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

describe("harness command lines", () => {
  it("denies Git writes on both native solver shell settings", () => {
    for (const shell of [true, false]) {
      const args = claudeArgs({ role: "solver", harness: "claude-code", model: "", system: "prompt", project: "/project", toggles: { shell } });
      const denied = args.slice(args.indexOf("--disallowedTools") + 1, args.indexOf("--dangerously-skip-permissions"));
      for (const verb of ["add", "stage", "commit", "stash", "reset", "checkout", "switch", "push"]) {
        expect(denied).toContain(`Bash(git ${verb}:*)`);
      }
      expect(denied).toContain("Read(.env*)");
      expect(denied).toContain("Edit(.env*)");
      expect(denied.includes("Bash")).toBe(!shell);
      expect(denied).not.toContain("Bash(git status:*)");
    }
  });

  it("Claude Code: yolo, no tools for the router, effort, fast mode through settings", () => {
    const a = claudeArgs(spec({ level: "low" }));
    expect(a).toContain("--dangerously-skip-permissions");
    expect(after(a, "--tools")).toBe("");
    expect(after(a, "--effort")).toBe("low");
    expect(a).not.toContain("--settings");
    expect(after(a, "--system-prompt")).toBe("SYS");
    expect(a).toContain("--no-session-persistence");
    // The solver without a project folder has no tools either, and its prompt is all there is.
    const bare = claudeArgs(spec({ role: "solver", toggles: { shell: false, web: false, subagents: false } }));
    expect(after(bare, "--tools")).toBe("");
    expect(after(bare, "--system-prompt")).toBe("SYS");
  });

  it("Claude Code: the solver in a project runs as Claude Code itself, with our prompt appended and its own tools", () => {
    const o = claudeArgs(spec({ role: "solver", model: "claude-opus-5-5", level: "max", speed: "fast", project: "/p" }));
    expect(after(o, "--tools")).toBe("default");
    expect(after(o, "--append-system-prompt")).toBe("SYS");
    expect(o).not.toContain("--system-prompt");
    // Every switch is on unless it's turned off: the whole setup loads.
    expect(o).not.toContain("--safe-mode");
    expect(o).not.toContain("--strict-mcp-config");
    expect(o).not.toContain("--disable-slash-commands");
    const denied = o.slice(o.indexOf("--disallowedTools") + 1, o.indexOf("--dangerously-skip-permissions"));
    expect(denied).toEqual([
      "EnterWorktree", "ExitWorktree", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "Monitor", "Read(.env*)", "Edit(.env*)",
      "Bash(git add:*)", "Bash(git stage:*)", "Bash(git commit:*)", "Bash(git stash:*)",
      "Bash(git reset:*)", "Bash(git checkout:*)", "Bash(git switch:*)", "Bash(git push:*)",
    ]);
    expect(JSON.parse(after(o, "--settings")!)).toEqual({ fastMode: true });
    expect(o).not.toContain("--restricted"); // it refuses bypass mode
  });

  it("Claude Code: a session is saved under an id, resumed by it, or forked; other agents save nothing", () => {
    expect(claudeSessionArgs()).toEqual(["--no-session-persistence"]);
    expect(claudeSessionArgs({ start: { kind: "new" }, id: "u1" })).toEqual(["--session-id", "u1"]);
    expect(claudeSessionArgs({ start: { kind: "resume", ref: { id: "u1" } } })).toEqual(["--resume", "u1"]);
    expect(claudeSessionArgs({ start: { kind: "fork", ref: { id: "u1" } } })).toEqual(["--resume", "u1", "--fork-session"]);
    const a = claudeArgs(spec({ role: "solver", project: "/p" }), () => [], { start: { kind: "resume", ref: { id: "u1" } } });
    expect(a).not.toContain("--no-session-persistence");
    expect(after(a, "--resume")).toBe("u1");
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
    const o = rpcArgs(spec({ harness: "pi", role: "solver", model: "", project: "/p", toggles: { shell: false } }));
    expect(after(o, "--tools")).toBe("read,edit,write,grep,find,ls");
    expect(o).not.toContain("--model");
  });

  it("Pi and OhMyPi: the solver in a project keeps the harness's prompt and, with every tool switch on, its whole tool set", () => {
    const pi = rpcArgs(spec({ harness: "pi", role: "solver", model: "", project: "/p" }));
    expect(after(pi, "--append-system-prompt")).toBe("SYS");
    expect(pi).not.toContain("--system-prompt");
    expect(pi).not.toContain("--tools");
    expect(pi).not.toContain("--no-tools");
    expect(pi).not.toEqual(expect.arrayContaining(["--no-extensions"]));
    const omp = rpcArgs(spec({ harness: "omp", role: "solver", model: "x/y", project: "/p" }));
    expect(omp.some((a) => a.startsWith("--tools"))).toBe(false);
    expect(omp).not.toContain("--no-lsp");
    expect(rpcArgs(spec({ harness: "omp", model: "x/y" }))).toContain("--no-lsp"); // the router has no use for it
  });

  it("Pi and OhMyPi: a session is saved by the harness, continued with --session, forked with --fork", () => {
    const s = spec({ harness: "omp", role: "solver", model: "x/y", project: "/p" });
    expect(rpcArgs(s)).toContain("--no-session");
    expect(rpcArgs({ ...s, persist: true })).not.toContain("--no-session");
    expect(rpcArgs(s, { kind: "new" })).not.toContain("--no-session");
    expect(after(rpcArgs(s, { kind: "resume", ref: { id: "i1", file: "/s/i1.jsonl" } }), "--session")).toBe("/s/i1.jsonl");
    expect(after(rpcArgs(s, { kind: "fork", ref: { id: "i1" } }), "--fork")).toBe("i1");
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

  it("Claude Code: a switch that's off takes its tools out of the solver's set, and its part of the setup with it", () => {
    const a = claudeArgs(spec({ role: "solver", project: "/p", toggles: { shell: false, web: false, subagents: false, skills: false } }), plugins);
    const denied = a.slice(a.indexOf("--disallowedTools") + 1, a.indexOf("--dangerously-skip-permissions"));
    expect(denied).toEqual(expect.arrayContaining(["Bash", "WebSearch", "WebFetch", "Task", "Skill", "Read(.env*)"]));
    expect(after(a, "--tools")).toBe("default"); // without Bash, Claude Code brings Glob and Grep itself
    expect(a).toContain("--disable-slash-commands");
    const bare = claudeArgs(spec({ role: "solver", project: "/p", toggles: { mcp: false, skills: false, hooks: false, plugins: false, instructions: false } }), plugins);
    expect(bare).toEqual(expect.arrayContaining(["--safe-mode", "--strict-mcp-config"]));
  });

  it("Claude Code: the fast tier's switches still add tools one by one (the router has none unless asked)", () => {
    const a = claudeArgs(spec({ toggles: { shell: true, web: true, subagents: true } }));
    expect(a.slice(a.indexOf("--tools") + 1, a.indexOf("--dangerously-skip-permissions"))).toEqual(["Bash", "WebSearch", "WebFetch", "Agent"]);
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
    // The solver: nothing is turned off unless a switch is.
    expect(codexConfig(spec({ harness: "codex", role: "solver", project: "/p" }), ["m1"])).toEqual({});
    expect(codexConfig(spec({ harness: "codex", role: "solver", project: "/p", toggles: { web: false } }), ["m1"])).toEqual({ web_search: "disabled" });
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

  it("Grok: the solver in a project keeps Grok's own tools, minus the switches that are off and what needs a person", () => {
    const s = spec({ harness: "grok", role: "solver", project: "/p" });
    expect(grokDisallowed(s)).toEqual(["ask_user_question", "enter_plan_mode", "exit_plan_mode", "send_feedback", "scheduler_create", "scheduler_delete", "scheduler_list", "monitor"]);
    const a = grokArgs(s, "hi");
    expect(a).toContain("--rules");
    expect(a).not.toContain("--max-turns"); // the task's time limit stops it
    expect(a).not.toEqual(expect.arrayContaining(["--disable-web-search"]));
    const noShell = grokDisallowed({ ...s, toggles: { shell: false } });
    expect(noShell).toContain("run_terminal_command");
    expect(noShell).not.toContain("kill_command_or_subagent"); // subagents still use it
    expect(grokDisallowed({ ...s, toggles: { shell: false, subagents: false } })).toEqual(expect.arrayContaining(["kill_command_or_subagent", "spawn_subagent"]));
  });

  it("Grok: a session starts under an id, later requests resume it (its rules stay), a fork starts from another", () => {
    const s = spec({ harness: "grok", role: "solver", project: "/p" });
    const first = grokArgs(s, "hi", { id: "u1", mode: "new" });
    expect(after(first, "-s")).toBe("u1");
    expect(first).toContain("--rules");
    const next = grokArgs(s, "hi", { id: "u1", mode: "resume" });
    expect(after(next, "-r")).toBe("u1");
    expect(next).not.toContain("--rules");
    expect(next).not.toContain("--fork-session");
    expect(grokArgs(s, "hi", { id: "u1", mode: "fork" })).toEqual(expect.arrayContaining(["-r", "u1", "--fork-session"]));
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
    // The solver in a project: every built-in tool but the one that waits for a person, and nothing switched off.
    const solver = spec({ harness: "opencode", role: "solver", project: "/p" });
    expect(describeAgent(solver)).toMatch(/^opencode serve · .*tools: read,glob,grep,edit,write,apply_patch,todowrite,bash,webfetch,websearch,task,skill /);
    expect(opencodeSetup(solver)).toEqual({ pure: false, env: {} });
  });

  it("Pi and OhMyPi: discovery flags drop when toggled on; tools join the allowlist", () => {
    const pi = rpcArgs(spec({ harness: "pi", toggles: { shell: true, skills: true, plugins: true, instructions: true } }));
    expect(pi).not.toEqual(expect.arrayContaining(["--no-skills"]));
    expect(pi).not.toContain("--no-extensions");
    expect(pi).not.toContain("--no-context-files");
    expect(after(pi, "--tools")).toBe("bash");
    // The solver with a tool switch off: an allowlist of what's left (omp has no way to name only what to leave out).
    const omp = rpcArgs(spec({ harness: "omp", role: "solver", project: "/p", toggles: { shell: false, plugins: false, skills: false, instructions: false } }));
    expect(omp).toContain("--tools=read,edit,write,grep,glob,find,todo,web_search,task");
    expect(omp).toEqual(expect.arrayContaining(["--no-extensions", "--no-skills", "--no-rules"]));
  });

  it("a toggle a harness doesn't list is off; the fast tier's switches start off, the smart tier's on", () => {
    expect(toggleOn("pi", { web: true }, "web", "smart")).toBe(false);
    expect(toggleOn("codex", undefined, "shell", "fast")).toBe(true);
    expect(toggleOn("claude-code", undefined, "shell", "fast")).toBe(false);
    expect(toggleOn("claude-code", undefined, "shell", "smart")).toBe(true);
    expect(toggleOn("claude-code", { shell: false }, "shell", "smart")).toBe(false);
  });

  it("cleanToggles keeps only changes from the tier's defaults", () => {
    expect(cleanToggles("codex", { shell: true, web: true, images: false }, "fast")).toEqual({ web: true });
    expect(cleanToggles("pi", { web: true }, "fast")).toBeUndefined();
    expect(cleanToggles("codex", { shell: true, web: true, images: false }, "smart")).toEqual({ images: false });
    expect(cleanToggles("claude-code", { shell: true, mcp: true }, "smart")).toBeUndefined();
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
