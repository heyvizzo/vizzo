// The coding-agent harnesses that run the model tiers, as agents a warm pool (warmPool.ts) can start ahead of
// time. One agent = one request with a fresh context; each harness gets there its own way:
//   claude-code  `claude -p` started with its prompt and flags, waiting for the message on stdin (stream-json)
//   codex        a thread created ahead on one shared `codex app-server` (JSON-RPC over stdio); the request is a turn
//   opencode     a session created ahead on one shared `opencode serve` (HTTP + SSE events); the request is a message
//   pi, omp      `pi|omp --mode rpc` started with its prompt and flags, waiting for a `prompt` command
//   grok         cold only: `grok -p` reads its prompt before it boots, and its ACP mode ignores our prompt and
//                tool limits, so each request spawns it
// Element threads (harnessThread.ts) keep one agent across requests instead (`keep`): claude-code's process stays
// open, codex's thread (not ephemeral) takes more turns, opencode's session more messages, pi/omp more prompts.
// Every harness runs in yolo mode (no approval prompts: nobody is there to answer them). The router and the
// progress lines get an empty folder; the solver gets the project folder with file tools. Anything more (shell,
// web, subagents, MCP servers, skills, hooks, plugins, instruction files) is off unless the tier's toggles turn it
// on (shared/config.ts HARNESS_TOGGLES); each harness below maps them to its own flags, config or environment.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative } from "node:path";
import { HARNESS_TOGGLES, LLM_PROVIDER_LABELS, toggleOn, type HarnessId, type HarnessToggleId, type HarnessToggles, type LlmSpeed } from "../../shared/config.ts";
import { priceOf, tokenCost } from "../prices.ts";
import { CLAUDE_BASE_ARGS, CliAgent, EMPTY_CWD, runStreamJson, type CliRole } from "./claudeCli.ts";

/** Token usage in the Anthropic shape (input excludes cache reads), plus what the call cost and who pays. */
export interface LlmUsage {
  input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number;
  /** `usd` null: price unknown. "subscription": the CLI's own login (not billed per call; `usd` is what it would cost at API prices). */
  llmCost: { usd: number | null; billing: "api" | "subscription" };
}

export interface HarnessResult {
  text: string;
  stopReason: string | null;
  model: string;
  /** Claude Code: its usage as reported (priced from the Claude table in cost.ts). Others: LlmUsage. */
  usage: unknown;
  /** Final events / response, as received (debug view). */
  raw: unknown;
  /** The agent had finished starting before the request (no start-up wait). */
  warm: boolean;
  /** Project-relative files the request edited, from the harness's tool events (best effort; absent: unknown). */
  filesTouched?: string[];
}

/** What an agent starts with. Fixed for its life: a different choice means a different agent. */
export interface AgentSpec {
  role: CliRole;
  harness: HarnessId;
  /** "" = the harness's default model. */
  model: string;
  level?: string;
  speed?: LlmSpeed;
  /** What it loads besides its file tools; left out = every toggle at its default. */
  toggles?: HarnessToggles;
  system: string;
  /** The solver's project folder, worked in with file tools. Omitted: an empty folder, no tools. */
  project?: string;
}

export interface WarmAgent {
  /** False once used, killed or crashed: the pool drops it. */
  alive(): boolean;
  /** Start-up finished: a request now doesn't wait for it. */
  ready(): boolean;
  request(user: string, onText: ((d: string) => void) | undefined, timeoutMs: number): Promise<HarnessResult>;
  kill(): void;
  /**
   * Element threads: from now on a request doesn't end the session, the next one continues it. Only on a pooled
   * agent not used yet; false = can't (the caller makes a new agent with `keep` instead).
   */
  keep?(): boolean;
  /** Kept agents: stop the in-flight request (its request() rejects). Without it, kill() is used (session lost). */
  abort?(): void;
  /**
   * The process this agent alone runs in, while it runs (RAM per thread). Absent: none of its own (codex and
   * opencode share one server process; grok runs a process per request only).
   */
  pid?(): number | undefined;
}

/** Makes an agent; `keep`: an element-thread agent from the start (codex: a non-ephemeral thread). */
export type AgentFactory = (spec: AgentSpec, keep?: boolean) => WarmAgent;

// ── Binaries ──────────────────────────────────────────────────────────────────

const ENV_BIN: Record<HarnessId, string> = {
  "claude-code": "CLAUDE_BIN", codex: "CODEX_BIN", grok: "GROK_BIN", opencode: "OPENCODE_BIN", pi: "PI_BIN", omp: "OMP_BIN",
};
const BIN_NAME: Record<HarnessId, string> = { "claude-code": "claude", codex: "codex", grok: "grok", opencode: "opencode", pi: "pi", omp: "omp" };
/** Install folders that aren't always on the server's PATH (bun's global bin holds omp). */
const EXTRA_DIRS = [join(homedir(), ".bun", "bin"), join(homedir(), ".local", "bin"), "/opt/homebrew/bin"];

/** The harness's executable: $<NAME>_BIN, else found on PATH or in the usual install folders; null if missing. */
export function harnessBin(id: HarnessId): string | null {
  const override = process.env[ENV_BIN[id]];
  if (override) return override;
  const dirs = [...(process.env.PATH ?? "").split(":").filter(Boolean), ...EXTRA_DIRS];
  for (const d of dirs) {
    const p = join(d, BIN_NAME[id]);
    if (existsSync(p)) return p;
  }
  return null;
}
const binOrThrow = (id: HarnessId): string => {
  const b = harnessBin(id);
  if (!b) throw new Error(`${LLM_PROVIDER_LABELS[id]} isn't installed (${BIN_NAME[id]} not found)`);
  return b;
};

// ── Shared helpers ───────────────────────────────────────────────────────────

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const on = (spec: AgentSpec, id: HarnessToggleId): boolean => toggleOn(spec.harness, spec.toggles, id);
/** The toggles on, by label (prompt inspector). */
const onLabels = (spec: AgentSpec): string => HARNESS_TOGGLES[spec.harness].filter((t) => on(spec, t.id)).map((t) => t.label).join(", ") || "none";
const cwdOf = (spec: AgentSpec): string => { const d = spec.project ?? EMPTY_CWD; mkdirSync(d, { recursive: true }); return d; };

function llmUsage(t: { input: number; output: number; cacheRead?: number; cacheWrite?: number }, cost: LlmUsage["llmCost"]): LlmUsage {
  return {
    input_tokens: t.input, output_tokens: t.output, cache_read_input_tokens: t.cacheRead ?? 0, cache_creation_input_tokens: t.cacheWrite ?? 0,
    llmCost: cost,
  };
}

/** Rejects after `ms` (and runs `onTimeout`) unless `p` settles first. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => { timer = setTimeout(() => { onTimeout(); reject(new Error(`${label} timed out after ${ms} ms`)); }, ms); }),
  ]);
}

/** Splits stdout into JSON lines (LF only: pi's RPC framing allows U+2028 inside strings). */
function jsonLines(proc: ChildProcessWithoutNullStreams, onLine: (ev: Record<string, unknown>) => void): void {
  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "").trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("{")) continue;
      try { onLine(JSON.parse(line)); } catch { /* not JSON */ }
    }
  });
}

// ── Files touched (element threads) ─────────────────────────────────────────

/** `p` relative to the project (normalized); a path outside it stays as given. */
export function projectRelative(project: string | undefined, p: string): string {
  if (!project) return p;
  if (!isAbsolute(p)) return normalize(p);
  const r = relative(project, p);
  return r && !r.startsWith("..") && !isAbsolute(r) ? r : p;
}

/** Collects the files a run edited, deduped, project-relative. */
export class FilesTouched {
  private set = new Set<string>();
  constructor(private project: string | undefined) {}
  add(p: unknown): void { if (typeof p === "string" && p.trim()) this.set.add(projectRelative(this.project, p.trim())); }
  get list(): string[] { return [...this.set]; }
}

const CLAUDE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Claude Code stream-json: the files an `assistant` event's Edit/Write/MultiEdit/NotebookEdit tool_use blocks edit. */
export function claudeEditedFiles(ev: Record<string, unknown>): string[] {
  if (ev.type !== "assistant") return [];
  const content = (ev.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const b of content as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
    if (b?.type !== "tool_use" || !b.name || !CLAUDE_EDIT_TOOLS.has(b.name)) continue;
    const p = b.input?.file_path ?? b.input?.notebook_path;
    if (typeof p === "string") out.push(p);
  }
  return out;
}

/** Paths named in an apply_patch text (`*** Update File: x`, Add, Delete, `*** Move to: y`). */
export function patchFiles(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((m) => (m[1] ?? m[2]!).trim());
}

/** Codex: the paths of a completed `fileChange` item. */
export function codexEditedFiles(item: unknown): string[] {
  const it = item as { type?: string; changes?: { path?: string }[] } | undefined;
  if (it?.type !== "fileChange" || !Array.isArray(it.changes)) return [];
  return it.changes.map((c) => c.path).filter((p): p is string => typeof p === "string");
}

const OPENCODE_EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "patch", "multiedit"]);
/** opencode: the files a completed edit/write/apply_patch tool part edited. */
export function opencodeEditedFiles(part: unknown): string[] {
  const p = part as { type?: string; tool?: string; state?: { status?: string; input?: Record<string, unknown> } } | undefined;
  if (p?.type !== "tool" || !p.tool || !OPENCODE_EDIT_TOOLS.has(p.tool) || p.state?.status !== "completed") return [];
  const input = p.state.input ?? {};
  const fp = input.filePath ?? input.file_path ?? input.path;
  if (typeof fp === "string") return [fp];
  return typeof input.patchText === "string" ? patchFiles(input.patchText) : [];
}

const RPC_EDIT_TOOLS = new Set(["edit", "write", "multiedit", "apply_patch", "patch", "notebook_edit", "ast_edit"]);
/** Pi / OhMyPi rpc: the file a `tool_execution_start` of an edit/write tool targets. */
export function rpcEditedFiles(ev: Record<string, unknown>): string[] {
  if (ev.type !== "tool_execution_start" || typeof ev.toolName !== "string" || !RPC_EDIT_TOOLS.has(ev.toolName)) return [];
  const a = (ev.args ?? {}) as Record<string, unknown>;
  const fp = a.path ?? a.file_path ?? a.filePath;
  if (typeof fp === "string") return [fp];
  const patch = a.input ?? a.patch ?? a.patchText;
  return typeof patch === "string" ? patchFiles(patch) : [];
}

// ── Claude Code ──────────────────────────────────────────────────────────────

/** The solver's tools in the project folder, and the secrets it may never touch. */
const CLAUDE_FILE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];
const CLAUDE_DENY = ["Read(.env*)", "Edit(.env*)"];

/** The toggles that need Claude Code's customizations loaded (no --safe-mode). */
const CLAUDE_SETUP: HarnessToggleId[] = ["mcp", "skills", "hooks", "plugins", "instructions"];
const claudeCustom = (spec: AgentSpec): boolean => CLAUDE_SETUP.some((id) => on(spec, id));

/** The plugins enabled in ~/.claude/settings.json (turned off one by one when plugins are off but not everything is). */
function claudePlugins(): string[] {
  try {
    const s = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8")) as { enabledPlugins?: Record<string, boolean> };
    return Object.entries(s.enabledPlugins ?? {}).filter(([, v]) => v).map(([k]) => k);
  } catch { return []; }
}

export function claudeArgs(spec: AgentSpec, plugins: () => string[] = claudePlugins): string[] {
  const tools = [
    ...(spec.project ? CLAUDE_FILE_TOOLS : []), ...(on(spec, "shell") ? ["Bash"] : []),
    ...(on(spec, "web") ? ["WebSearch", "WebFetch"] : []), ...(on(spec, "subagents") ? ["Agent"] : []),
  ];
  // Nothing of the setup on: --safe-mode drops all of it (CLAUDE.md, skills, plugins, hooks, MCP and the rest).
  // Some of it on: it all loads, and each part that's off is turned off on its own.
  const custom = claudeCustom(spec);
  const settings = {
    // Opus fast mode. Needs usage credits on the account; without them Claude Code serves standard speed.
    ...(spec.speed === "fast" ? { fastMode: true } : {}),
    ...(custom && !on(spec, "hooks") ? { disableAllHooks: true } : {}),
    ...(custom && !on(spec, "plugins") ? { enabledPlugins: Object.fromEntries(plugins().map((p) => [p, false])) } : {}),
  };
  return [
    ...CLAUDE_BASE_ARGS,
    ...(custom ? [] : ["--safe-mode"]),
    ...(on(spec, "mcp") ? [] : ["--strict-mcp-config"]),
    // --safe-mode still loads the bundled skills.
    ...(on(spec, "skills") ? [] : ["--disable-slash-commands"]),
    "--tools", ...(tools.length ? tools : [""]),
    "--dangerously-skip-permissions",
    ...(spec.project ? ["--disallowedTools", ...CLAUDE_DENY] : []),
    ...(spec.model ? ["--model", spec.model] : []),
    ...(spec.level ? ["--effort", spec.level] : []),
    ...(Object.keys(settings).length ? ["--settings", JSON.stringify(settings)] : []),
    "--system-prompt", spec.system,
  ];
}

/** CLAUDE.md files and auto memory off while the rest of the setup loads. */
export function claudeEnv(spec: AgentSpec): NodeJS.ProcessEnv {
  if (!claudeCustom(spec) || on(spec, "instructions")) return process.env;
  return { ...process.env, CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
}

class ClaudeAgent implements WarmAgent {
  private cli: CliAgent;
  private used = false;
  constructor(private spec: AgentSpec, private kept = false) {
    this.cli = new CliAgent(spec.role, binOrThrow("claude-code"), claudeArgs(spec), cwdOf(spec), claudeEnv(spec));
  }
  alive(): boolean { return (this.kept || !this.used) && !this.cli.exited; }
  // claude -p prints nothing until it gets the message: count it as booted after a typical start-up.
  ready(): boolean { return performance.now() - this.cli.spawnedAt > 800; }
  keep(): boolean { if (this.used) return false; this.kept = true; return true; }
  async request(user: string, onText: ((d: string) => void) | undefined, timeoutMs: number): Promise<HarnessResult> {
    this.used = true;
    const warm = this.ready();
    const files = new FilesTouched(this.spec.project);
    const onEvent = (ev: Record<string, unknown>): void => { for (const f of claudeEditedFiles(ev)) files.add(f); };
    const r = await this.cli.request(user, { onText, onEvent }, timeoutMs, warm, this.kept);
    return {
      text: r.text, stopReason: r.stopReason, model: r.model ?? this.spec.model, usage: r.usage, warm,
      raw: { ...r.raw, cliCostUsd: r.cliCostUsd, cliDurationMs: r.durationMs }, filesTouched: files.list,
    };
  }
  pid(): number | undefined { return this.cli.exited ? undefined : this.cli.proc.pid; }
  // No interrupt over stream-json input here: the process goes (the thread reopens with its replay).
  abort(): void { this.cli.kill(); }
  kill(): void { this.cli.kill(); }
}

// ── Grok (cold) ──────────────────────────────────────────────────────────────

/** Grok's built-in tools: the solver has the file tools, the toggles add more; the rest are disallowed. */
const GROK_TOOLS = [
  "run_terminal_command", "read_file", "search_replace", "list_dir", "grep", "kill_command_or_subagent", "todo_write",
  "get_command_or_subagent_output", "spawn_subagent", "scheduler_create", "scheduler_delete", "scheduler_list", "monitor",
  "search_tool", "use_tool", "workflow", "enter_plan_mode", "exit_plan_mode", "ask_user_question", "send_feedback",
  "web_search", "web_fetch", "image_gen", "image_edit", "image_to_video", "reference_to_video", "write",
];
const GROK_FILE_TOOLS = ["read_file", "search_replace", "list_dir", "grep", "write"];
/** The tools each toggle adds (MCP tools are reached through search_tool/use_tool). */
const GROK_TOGGLE_TOOLS: Partial<Record<HarnessToggleId, string[]>> = {
  shell: ["run_terminal_command", "kill_command_or_subagent", "get_command_or_subagent_output"],
  web: ["web_search", "web_fetch"],
  subagents: ["spawn_subagent", "kill_command_or_subagent", "get_command_or_subagent_output"],
  mcp: ["search_tool", "use_tool"],
};

export function grokArgs(spec: AgentSpec, user: string): string[] {
  const allowed = new Set([
    ...(spec.project ? GROK_FILE_TOOLS : []),
    ...Object.entries(GROK_TOGGLE_TOOLS).flatMap(([id, tools]) => (on(spec, id as HarnessToggleId) ? tools : [])),
  ]);
  return [
    "-p", user, "--output-format", "streaming-messages-json", "--include-partial-messages",
    ...(spec.model ? ["-m", spec.model] : []), ...(spec.level ? ["--reasoning-effort", spec.level] : []),
    "--always-approve", ...(on(spec, "web") ? [] : ["--disable-web-search"]), ...(on(spec, "subagents") ? [] : ["--no-subagents"]), "--no-plan",
    // With tools, --rules appends to Grok's own prompt (which explains them); without, ours replaces it.
    ...(allowed.size
      ? ["--rules", spec.system, ...(spec.project ? ["--cwd", spec.project] : []), "--max-turns", "40"]
      : ["--system-prompt-override", spec.system, "--max-turns", "1"]),
    `--disallowed-tools=${GROK_TOOLS.filter((t) => !allowed.has(t)).join(",")}`,
  ];
}

/** Grok's scans of Claude's and Cursor's setup (GROK_<VENDOR>_<CELL>_ENABLED), per toggle. */
const GROK_COMPAT: Partial<Record<HarnessToggleId, string[]>> = { skills: ["SKILLS"], hooks: ["HOOKS"], mcp: ["MCPS"], instructions: ["RULES", "AGENTS"] };
/** What of ~/.grok the toggles keep in a Grok home of our own (the rest is left out). */
const GROK_HOME_PARTS: Partial<Record<HarnessToggleId, string>> = { skills: "skills", hooks: "hooks", plugins: "installed-plugins" };

/**
 * Grok's environment. `grok -p` ignores config overlays (GROK_CONFIG), so whatever of ~/.grok is off comes from a
 * Grok home of our own: the login linked in, the parts that are on linked in, and config.toml copied without its
 * [plugins] / [mcp_servers] tables when those are off. Claude's and Cursor's setup is turned off per part.
 */
export function grokEnv(spec: AgentSpec, homes = join(homedir(), ".config", "vizzo", "grok-home")): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [id, cells] of Object.entries(GROK_COMPAT)) {
    if (on(spec, id as HarnessToggleId)) continue;
    for (const vendor of ["CLAUDE", "CURSOR"]) for (const cell of cells) env[`GROK_${vendor}_${cell}_ENABLED`] = "0";
  }
  const own = (["skills", "hooks", "plugins", "mcp"] as const).filter((id) => on(spec, id));
  if (own.length < 4) env.GROK_HOME = join(homes, own.join("-") || "none");
  return env;
}

/** Make the Grok home `env` names (if any) for `spec`: see grokEnv. */
export function prepareGrokHome(spec: AgentSpec, env: NodeJS.ProcessEnv, realHome = process.env.GROK_HOME ?? join(homedir(), ".grok")): NodeJS.ProcessEnv {
  const home = env.GROK_HOME;
  if (!home || home === process.env.GROK_HOME) return env;
  try {
    mkdirSync(home, { recursive: true });
    for (const [id, part] of [["auth", "auth.json"], ...Object.entries(GROK_HOME_PARTS)] as [string, string][]) {
      const link = join(home, part);
      rmSync(link, { force: true, recursive: false });
      if ((id === "auth" || on(spec, id as HarnessToggleId)) && existsSync(join(realHome, part))) symlinkSync(join(realHome, part), link);
    }
    const drop = [...(on(spec, "plugins") ? [] : ["plugins"]), ...(on(spec, "mcp") ? [] : ["mcp_servers"])];
    let config = "";
    try { config = readFileSync(join(realHome, "config.toml"), "utf8"); } catch { /* none */ }
    writeFileSync(join(home, "config.toml"), withoutTomlTables(config, drop));
  } catch (e) {
    console.error(`[grok] couldn't set up ${home}: ${e instanceof Error ? e.message : String(e)}`);
    const { GROK_HOME: _h, ...rest } = env;
    return rest;
  }
  return env;
}

/** `toml` without the tables named (`[name]`, `[name.x]`, `[[name…]]`) and their keys. */
export function withoutTomlTables(toml: string, names: string[]): string {
  let skip = false;
  return toml.split("\n").filter((line) => {
    const m = /^\s*\[\[?\s*([A-Za-z0-9_-]+)/.exec(line);
    if (m) skip = names.includes(m[1]!);
    return !skip;
  }).join("\n");
}

class GrokAgent implements WarmAgent {
  private used = false;
  constructor(private spec: AgentSpec) { binOrThrow("grok"); }
  alive(): boolean { return !this.used; }
  ready(): boolean { return false; }
  async request(user: string, onText: ((d: string) => void) | undefined, timeoutMs: number): Promise<HarnessResult> {
    this.used = true;
    let apiKeySource = "";
    const res = await runStreamJson(`grok ${this.spec.role}`, binOrThrow("grok"), grokArgs(this.spec, user), cwdOf(this.spec), {
      onText,
      onEvent: (ev) => { if (ev.type === "system" && ev.subtype === "init") apiKeySource = String(ev.apiKeySource ?? ""); },
    }, timeoutMs, prepareGrokHome(this.spec, grokEnv(this.spec)));
    const u = (res.usage ?? {}) as Record<string, unknown>;
    const t = { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens) };
    const model = res.model ?? (this.spec.model || "grok default");
    const price = priceOf("grok", model);
    return {
      text: res.text, stopReason: res.stopReason, model, raw: res.raw, warm: false, filesTouched: [],
      // Logged in with grok.com (OAuth): the subscription pays.
      usage: llmUsage(t, { usd: res.cliCostUsd ?? (price ? tokenCost(price, t) : null), billing: apiKeySource === "oauth" ? "subscription" : "api" }),
    };
  }
  kill(): void { /* nothing runs until a request */ }
}

// ── Pi and OhMyPi (RPC mode) ─────────────────────────────────────────────────

/** Each harness's file tools (the solver's) and the tools a toggle adds. */
const RPC_TOOLS: Record<"pi" | "omp", { files: string[]; toggles: Partial<Record<HarnessToggleId, string[]>> }> = {
  pi: { files: ["read", "edit", "write", "grep", "find", "ls"], toggles: { shell: ["bash"] } },
  omp: {
    files: ["read", "edit", "write", "grep", "glob", "find"],
    // omp 18 refuses `python`, `fetch` and `browser` in --tools (eval runs python; read fetches URLs).
    toggles: { shell: ["bash", "eval"], web: ["web_search"], subagents: ["task"] },
  },
};

export function rpcArgs(spec: AgentSpec): string[] {
  const t = RPC_TOOLS[spec.harness === "omp" ? "omp" : "pi"];
  const tools = [...(spec.project ? t.files : []), ...Object.entries(t.toggles).flatMap(([id, x]) => (on(spec, id as HarnessToggleId) ? x : []))];
  const common = [
    "--mode", "rpc", "--no-session",
    ...(on(spec, "plugins") ? [] : ["--no-extensions"]), ...(on(spec, "skills") ? [] : ["--no-skills"]),
    ...(spec.model ? ["--model", spec.model] : []), ...(spec.level ? ["--thinking", spec.level] : []),
    "--system-prompt", spec.system,
  ];
  if (spec.harness === "omp") {
    return [
      ...common, ...(on(spec, "instructions") ? [] : ["--no-rules"]), "--no-lsp", "--approval-mode=yolo",
      // OpenAI's priority tier; on Anthropic models omp sends Opus fast mode (speed: fast + its beta) instead.
      ...(spec.speed === "fast" ? ["--service-tier", "priority"] : []),
      ...(tools.length ? [`--tools=${tools.join(",")}`] : ["--no-tools"]),
    ];
  }
  // Pi has no approval prompts: it runs whatever its tools do.
  return [...common, ...(on(spec, "instructions") ? [] : ["--no-context-files"]), ...(tools.length ? ["--tools", tools.join(",")] : ["--no-tools"])];
}

class RpcAgent implements WarmAgent {
  private proc: ChildProcessWithoutNullStreams;
  private exited = false;
  private used = false;
  private booted = false;
  private stderr = "";
  private listener: ((ev: Record<string, unknown>) => void) | null = null;
  private exitWaiters: ((code: number | null) => void)[] = [];

  // --no-session keeps the conversation in memory only: a kept agent's next prompt continues it.
  constructor(private spec: AgentSpec, private kept = false) {
    this.proc = spawn(binOrThrow(spec.harness), rpcArgs(spec), { cwd: cwdOf(spec), stdio: ["pipe", "pipe", "pipe"], env: process.env });
    jsonLines(this.proc, (ev) => {
      if (ev.type === "response" && ev.id === "boot") { this.booted = true; return; }
      this.listener?.(ev);
    });
    this.proc.stderr.on("data", (d: Buffer) => { this.stderr = (this.stderr + d.toString()).slice(-2000); });
    this.proc.on("close", (code) => { this.exited = true; for (const w of this.exitWaiters) w(code); });
    this.proc.on("error", (e) => { this.exited = true; this.stderr += String(e); });
    // Answered once the agent has loaded its models and tools: that's "booted".
    this.proc.stdin.write(JSON.stringify({ id: "boot", type: "get_state" }) + "\n");
  }

  alive(): boolean { return (this.kept || !this.used) && !this.exited; }
  ready(): boolean { return this.booted; }
  keep(): boolean { if (this.used) return false; this.kept = true; return true; }
  abort(): void { if (!this.exited) this.proc.stdin.write(JSON.stringify({ id: "abort", type: "abort" }) + "\n"); }
  pid(): number | undefined { return this.exited ? undefined : this.proc.pid; }

  async request(user: string, onText: ((d: string) => void) | undefined, timeoutMs: number): Promise<HarnessResult> {
    this.used = true;
    const warm = this.booted;
    const files = new FilesTouched(this.spec.project);
    const label = `${this.spec.harness} (${this.spec.role})`;
    let text = "";
    let model = this.spec.model;
    let provider = "";
    let stopReason: string | null = null;
    let failure = "";
    let cost = 0;
    let last: unknown = null;
    const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const done = new Promise<void>((resolve, reject) => {
      this.exitWaiters = [(code) => reject(new Error(`${label} exited (${code}) before answering: ${this.stderr.trim().slice(-300)}`))];
      this.listener = (ev) => {
        for (const f of rpcEditedFiles(ev)) files.add(f);
        const ame = ev.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (ev.type === "message_update" && ame?.type === "text_delta" && ame.delta) {
          text += ame.delta;
          onText?.(ame.delta);
        } else if (ev.type === "message_end") {
          const m = ev.message as { role?: string; usage?: Record<string, unknown>; stopReason?: string; errorMessage?: string; model?: string; provider?: string } | undefined;
          if (m?.role !== "assistant") return;
          last = m;
          const u = m.usage ?? {};
          t.input += num(u.input); t.output += num(u.output); t.cacheRead += num(u.cacheRead); t.cacheWrite += num(u.cacheWrite);
          cost += num((u.cost as Record<string, unknown> | undefined)?.total);
          stopReason = m.stopReason ?? null;
          if (m.provider) provider = m.provider;
          if (m.model) model = m.provider ? `${m.provider}/${m.model}` : m.model;
          if (m.stopReason === "error" || m.stopReason === "aborted") failure = m.errorMessage ?? m.stopReason;
        } else if (ev.type === "response" && ev.id === "abort") {
          // Answered by agent_end (stopReason aborted).
        } else if (ev.type === "response" && ev.success === false) {
          reject(new Error(`${label}: ${String(ev.error ?? "prompt rejected")}`));
        } else if (ev.type === "agent_end") {
          resolve();
        }
      };
    });
    this.proc.stdin.write(JSON.stringify({ id: "prompt", type: "prompt", message: user }) + "\n");
    try {
      await withTimeout(done, timeoutMs, label, () => this.kill());
    } finally {
      this.listener = null;
      this.exitWaiters = [];
      if (!this.kept) this.kill();
    }
    if (failure) throw new Error(`${label} failed: ${failure}`);
    // The ChatGPT login (openai-codex) is a subscription; other providers bill the keys pi/omp were given.
    const billing = provider === "openai-codex" ? "subscription" as const : "api" as const;
    const price = cost ? null : priceOf(this.spec.harness, model);
    return {
      text, stopReason: stopReason === "length" ? "max_tokens" : "end_turn", model: model || `${this.spec.harness} default`, warm, raw: last,
      filesTouched: files.list,
      usage: llmUsage(t, { usd: price ? tokenCost(price, t) : cost, billing }),
    };
  }

  kill(): void { if (!this.exited) this.proc.kill("SIGTERM"); }
}

// ── Codex (shared app-server, one thread per request) ────────────────────────

type Notify = (method: string, params: Record<string, unknown>) => void;

/** One `codex app-server` (JSON-RPC over stdio) shared by every Codex agent. */
class CodexServer {
  private static current: CodexServer | null = null;
  static get(): CodexServer {
    if (!CodexServer.current || CodexServer.current.exited) CodexServer.current = new CodexServer();
    return CodexServer.current;
  }
  static stop(): void { CodexServer.current?.proc.kill("SIGTERM"); CodexServer.current = null; }

  private proc: ChildProcessWithoutNullStreams;
  private id = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private threads = new Map<string, Notify>();
  private stderr = "";
  exited = false;
  readonly ready: Promise<void>;
  /** The MCP servers in the user's config: a thread with MCP off turns each one off (an empty table merges). */
  readonly mcpServers: Promise<string[]>;

  private constructor() {
    mkdirSync(EMPTY_CWD, { recursive: true });
    // What a thread loads is set per thread (codexConfig): the server starts with the user's config.
    this.proc = spawn(binOrThrow("codex"), ["app-server"], { cwd: EMPTY_CWD, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    jsonLines(this.proc, (m) => this.onMessage(m));
    this.proc.stderr.on("data", (d: Buffer) => { this.stderr = (this.stderr + d.toString()).slice(-2000); });
    this.proc.on("close", (code) => {
      this.exited = true;
      const err = new Error(`codex app-server exited (${code}): ${this.stderr.trim().slice(-300)}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      for (const n of this.threads.values()) n("server/exited", { message: err.message });
    });
    this.proc.on("error", (e) => { this.exited = true; this.stderr += String(e); });
    this.ready = this.call("initialize", { clientInfo: { name: "vizzo", title: null, version: "1" }, capabilities: null })
      .then(() => { this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n"); });
    this.ready.catch(() => {});
    this.mcpServers = this.ready.then(() => this.call("config/read", { includeLayers: false }))
      .then((r) => Object.keys((r as { config?: { mcp_servers?: Record<string, unknown> } }).config?.mcp_servers ?? {}))
      .catch(() => []);
  }

  private onMessage(m: Record<string, unknown>): void {
    const id = m.id as number | undefined;
    if (id !== undefined && !m.method) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (m.error) p.reject(new Error(`codex: ${JSON.stringify(m.error).slice(0, 300)}`));
      else p.resolve(m.result);
      return;
    }
    if (id !== undefined && m.method) {
      // Approval requests shouldn't come (approvalPolicy "never"); accept anything that does.
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result: { decision: "accept" } }) + "\n");
      return;
    }
    const params = (m.params ?? {}) as Record<string, unknown>;
    const tid = (params.threadId ?? (params.thread as { id?: string } | undefined)?.id) as string | undefined;
    if (tid) this.threads.get(tid)?.(String(m.method), params);
  }

  call(method: string, params: unknown): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error("codex app-server isn't running"));
    return new Promise((resolve, reject) => {
      const i = ++this.id;
      this.pending.set(i, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
    });
  }

  listen(threadId: string, fn: Notify | null): void { if (fn) this.threads.set(threadId, fn); else this.threads.delete(threadId); }
}

/**
 * A thread's config overrides: each toggle that's off turns its part off; one that's on leaves the user's config
 * as it is. `mcpServers`: the servers to turn off when MCP is.
 */
export function codexConfig(spec: AgentSpec, mcpServers: string[]): Record<string, unknown> {
  const features: Record<string, boolean> = {};
  const off = (id: HarnessToggleId, ...names: string[]): void => { if (!on(spec, id)) for (const n of names) features[n] = false; };
  off("shell", "shell_tool", "unified_exec");
  off("subagents", "multi_agent", "multi_agent_v2");
  off("images", "image_generation");
  off("hooks", "hooks");
  off("plugins", "plugins", "apps", "browser_use", "computer_use", "in_app_browser");
  return {
    ...(Object.keys(features).length ? { features } : {}),
    ...(on(spec, "web") ? {} : { web_search: "disabled" }),
    ...(on(spec, "mcp") || !mcpServers.length ? {} : { mcp_servers: Object.fromEntries(mcpServers.map((n) => [n, { enabled: false }])) }),
    ...(on(spec, "skills") ? {} : { skills: { include_instructions: false, bundled: { enabled: false } } }),
    ...(on(spec, "instructions") ? {} : { project_doc_max_bytes: 0 }),
  };
}

class CodexAgent implements WarmAgent {
  private server = CodexServer.get();
  private thread: Promise<string>;
  private threadId: string | null = null;
  private used = false;
  private failed = false;
  private turnId: string | null = null;

  /** `kept`: an element thread's (not ephemeral: it takes turn after turn). Pooled agents can't become one. */
  constructor(private spec: AgentSpec, private kept = false) {
    this.thread = this.server.mcpServers.then((mcp) => this.server.call("thread/start", {
      ...(spec.model ? { model: spec.model } : {}),
      config: codexConfig(spec, mcp),
      ...(spec.speed === "fast" ? { serviceTier: "priority" } : {}),
      cwd: cwdOf(spec), approvalPolicy: "never", sandbox: "danger-full-access", ephemeral: !kept,
      // The router's prompt replaces Codex's own; the solver keeps Codex's (it explains the tools) with ours added.
      ...(spec.project ? { developerInstructions: spec.system } : { baseInstructions: spec.system }),
    })).then((r) => (this.threadId = (r as { thread: { id: string } }).thread.id));
    this.thread.catch(() => { this.failed = true; });
  }

  alive(): boolean { return (this.kept || !this.used) && !this.failed && !this.server.exited; }
  ready(): boolean { return this.threadId !== null; }
  abort(): void { this.interrupt(); }
  private interrupt(): void {
    if (this.threadId && this.turnId) void this.server.call("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
  }

  async request(user: string, onText: ((d: string) => void) | undefined, timeoutMs: number): Promise<HarnessResult> {
    this.used = true;
    const warm = this.threadId !== null;
    const label = `codex (${this.spec.role})`;
    const threadId = await this.thread;
    const files = new FilesTouched(this.spec.project);
    let text = "";
    let usage: Record<string, unknown> = {};
    let turn: unknown = null;
    const done = new Promise<void>((resolve, reject) => {
      this.server.listen(threadId, (method, params) => {
        if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
          text += params.delta;
          onText?.(params.delta);
        } else if (method === "item/completed") {
          for (const f of codexEditedFiles(params.item)) files.add(f);
        } else if (method === "thread/tokenUsage/updated") {
          usage = ((params.tokenUsage as Record<string, unknown> | undefined)?.last ?? {}) as Record<string, unknown>;
        } else if (method === "turn/completed") {
          turn = params.turn;
          const t = params.turn as { status?: string; error?: { message?: string } | null } | undefined;
          if (t?.status === "completed") resolve();
          else reject(new Error(`${label} turn ${t?.status ?? "failed"}: ${t?.error?.message ?? ""}`));
        } else if (method === "server/exited") {
          reject(new Error(String(params.message)));
        } else if (method === "error" && !params.willRetry) {
          reject(new Error(`${label}: ${String((params.error as { message?: string } | undefined)?.message ?? "error")}`));
        }
      });
    });
    done.catch(() => {});
    try {
      const started = await this.server.call("turn/start", {
        threadId, input: [{ type: "text", text: user, text_elements: [] }],
        ...(this.spec.level ? { effort: this.spec.level } : {}),
      });
      this.turnId = (started as { turn?: { id?: string } } | null)?.turn?.id ?? null;
      await withTimeout(done, timeoutMs, label, () => this.interrupt());
    } finally {
      this.server.listen(threadId, null);
      this.turnId = null;
    }
    // OpenAI counts cached tokens inside input.
    const cached = num(usage.cachedInputTokens);
    const t = { input: Math.max(0, num(usage.inputTokens) - cached), output: num(usage.outputTokens), cacheRead: cached };
    const model = this.spec.model || "codex default";
    const price = priceOf("codex", model);
    return {
      text, stopReason: "end_turn", model, warm, raw: { turn, usage }, filesTouched: files.list,
      // Priced at the standard rate (the Fast tier spends the subscription's allowance faster, not money).
      usage: llmUsage(t, { usd: price ? tokenCost(price, t) : null, billing: "subscription" }),
    };
  }

  // Ephemeral: nothing to clean up. Kept: the thread stays on disk (codex's own history), unloaded with the server.
  kill(): void { this.failed = true; this.interrupt(); }
}

// ── opencode (shared `opencode serve`, one session per request) ─────────────

/** opencode's built-in tools (GET /experimental/tool/ids). `question` waits for a person: always off. */
const OPENCODE_TOOLS = ["invalid", "question", "bash", "read", "glob", "grep", "edit", "write", "task", "webfetch", "todowrite", "websearch", "skill", "apply_patch"];
const OPENCODE_FILE_TOOLS = ["read", "glob", "grep", "edit", "write", "apply_patch"];
const OPENCODE_TOGGLE_TOOLS: Partial<Record<HarnessToggleId, string[]>> = { shell: ["bash"], web: ["webfetch", "websearch"], subagents: ["task"], skills: ["skill"] };
const opencodeTools = (spec: AgentSpec): string[] => [
  ...(spec.project ? OPENCODE_FILE_TOOLS : []),
  ...Object.entries(OPENCODE_TOGGLE_TOOLS).flatMap(([id, tools]) => (on(spec, id as HarnessToggleId) ? tools : [])),
];
/** What a server loads is set when it starts: one server per such setup (plugins off = --pure). */
interface OpencodeSetup { pure: boolean; env: Record<string, string> }
export function opencodeSetup(spec: AgentSpec): OpencodeSetup {
  return {
    pure: !on(spec, "plugins"),
    env: {
      ...(on(spec, "skills") ? {} : { OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "true" }),
      ...(on(spec, "instructions") ? {} : { OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "true" }),
    },
  };
}
/** Yolo: allow everything opencode would otherwise ask about. */
const OPENCODE_CONFIG = JSON.stringify({
  permission: { edit: "allow", bash: "allow", webfetch: "allow", external_directory: "allow", doom_loop: "allow" },
});

type SessionListener = (type: string, props: Record<string, unknown>) => void;

class OpencodeServer {
  private static servers = new Map<string, OpencodeServer>();
  static get(setup: OpencodeSetup): OpencodeServer {
    const key = JSON.stringify(setup);
    let s = OpencodeServer.servers.get(key);
    if (!s || s.exited) OpencodeServer.servers.set(key, (s = new OpencodeServer(setup)));
    return s;
  }
  static stop(): void {
    for (const s of OpencodeServer.servers.values()) {
      for (const a of s.streams.values()) a.abort();
      s.proc?.kill("SIGTERM");
    }
    OpencodeServer.servers.clear();
  }

  private proc: ChildProcessWithoutNullStreams | null = null;
  private stderr = "";
  exited = false;
  readonly url: Promise<string>;
  private streams = new Map<string, AbortController>();
  private sessions = new Map<string, SessionListener>();

  private constructor(setup: OpencodeSetup) {
    mkdirSync(EMPTY_CWD, { recursive: true });
    this.url = freePort().then((port) => new Promise<string>((resolve, reject) => {
      const proc = spawn(binOrThrow("opencode"), ["serve", "--hostname", "127.0.0.1", "--port", String(port), ...(setup.pure ? ["--pure"] : [])], {
        cwd: EMPTY_CWD, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...setup.env, OPENCODE_CONFIG_CONTENT: OPENCODE_CONFIG },
      });
      this.proc = proc;
      const onOut = (d: Buffer) => {
        const m = /listening on (http:\/\/\S+)/.exec(d.toString());
        if (m) resolve(m[1]!.replace(/\/$/, ""));
      };
      proc.stdout.on("data", onOut);
      proc.stderr.on("data", (d: Buffer) => { this.stderr = (this.stderr + d.toString()).slice(-2000); onOut(d); });
      proc.on("close", (code) => { this.exited = true; reject(new Error(`opencode serve exited (${code}): ${this.stderr.trim().slice(-300)}`)); });
      proc.on("error", (e) => { this.exited = true; reject(e); });
    }));
    this.url.catch(() => {});
  }

  /** Subscribe to the event stream of `dir` (opencode scopes sessions and events by directory), once. */
  async watch(dir: string): Promise<void> {
    if (this.streams.has(dir)) return;
    const ctl = new AbortController();
    this.streams.set(dir, ctl);
    const res = await fetch(`${await this.url}/event?directory=${encodeURIComponent(dir)}`, { signal: ctl.signal });
    if (!res.ok || !res.body) { this.streams.delete(dir); throw new Error(`opencode /event ${res.status}`); }
    const body = res.body as unknown as AsyncIterable<Uint8Array>;
    void (async () => {
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for await (const chunk of body) {
          buf += decoder.decode(chunk, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = block.split("\n").find((l) => l.startsWith("data:"));
            if (!data) continue;
            let ev: { type?: string; properties?: Record<string, unknown> };
            try { ev = JSON.parse(data.slice(5)); } catch { continue; }
            const props = ev.properties ?? {};
            const sid = (props.sessionID ?? (props.part as { sessionID?: string } | undefined)?.sessionID) as string | undefined;
            if (sid) this.sessions.get(sid)?.(ev.type ?? "", props);
          }
        }
      } catch { /* aborted */ }
      this.streams.delete(dir);
    })();
  }

  listen(sessionId: string, fn: SessionListener | null): void { if (fn) this.sessions.set(sessionId, fn); else this.sessions.delete(sessionId); }

  async api(path: string, dir: string, init: { method: string; body?: unknown }): Promise<unknown> {
    const res = await fetch(`${await this.url}${path}?directory=${encodeURIComponent(dir)}`, {
      method: init.method, headers: { "content-type": "application/json" }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!res.ok) throw new Error(`opencode ${init.method} ${path} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); s.close(() => resolve(typeof a === "object" && a ? a.port : 0)); });
  });
}

class OpencodeAgent implements WarmAgent {
  private server: OpencodeServer;
  private dir: string;
  private session: Promise<string>;
  private sessionId: string | null = null;
  private used = false;
  private failed = false;
  private killed = false;

  constructor(private spec: AgentSpec, private kept = false) {
    this.server = OpencodeServer.get(opencodeSetup(spec));
    this.dir = cwdOf(spec);
    this.session = this.server.watch(this.dir)
      .then(() => this.server.api("/session", this.dir, { method: "POST", body: {} }))
      .then((s) => (this.sessionId = (s as { id: string }).id));
    this.session.catch(() => { this.failed = true; });
  }

  alive(): boolean { return (this.kept || !this.used) && !this.failed && !this.killed && !this.server.exited; }
  ready(): boolean { return this.sessionId !== null; }
  keep(): boolean { if (this.used) return false; this.kept = true; return true; }
  abort(): void { if (this.sessionId) void this.server.api(`/session/${this.sessionId}/abort`, this.dir, { method: "POST" }).catch(() => {}); }

  async request(user: string, onText: ((d: string) => void) | undefined, timeoutMs: number): Promise<HarnessResult> {
    this.used = true;
    const warm = this.sessionId !== null;
    const sid = await this.session;
    const files = new FilesTouched(this.spec.project);
    const slash = this.spec.model.indexOf("/");
    const allowed = opencodeTools(this.spec);
    // Text parts stream as deltas keyed by part id; reasoning parts are skipped. A delta that comes before
    // its part's type is known is held until then.
    const partType = new Map<string, string>();
    const held = new Map<string, string[]>();
    let streamed = "";
    const emit = (d: string): void => { streamed += d; onText?.(d); };
    this.server.listen(sid, (type, props) => {
      if (type === "message.part.updated") {
        const part = props.part as { id?: string; type?: string } | undefined;
        for (const f of opencodeEditedFiles(part)) files.add(f);
        if (!part?.id || !part.type || partType.has(part.id)) return;
        partType.set(part.id, part.type);
        const h = held.get(part.id);
        held.delete(part.id);
        if (part.type === "text" && h) for (const d of h) emit(d);
      } else if (type === "message.part.delta" && props.field === "text" && typeof props.delta === "string") {
        const id = String(props.partID ?? "");
        const known = partType.get(id);
        if (known === "text") emit(props.delta);
        else if (!known) held.set(id, [...(held.get(id) ?? []), props.delta]);
      }
    });
    try {
      const res = await withTimeout(this.server.api(`/session/${sid}/message`, this.dir, {
        method: "POST",
        body: {
          ...(slash > 0 ? { model: { providerID: this.spec.model.slice(0, slash), modelID: this.spec.model.slice(slash + 1) } } : {}),
          ...(this.spec.level ? { variant: this.spec.level } : {}),
          system: this.spec.system,
          tools: Object.fromEntries(OPENCODE_TOOLS.map((t) => [t, allowed.includes(t)])),
          parts: [{ type: "text", text: user }],
        },
      }), timeoutMs, `opencode (${this.spec.role})`, () => { void this.server.api(`/session/${sid}/abort`, this.dir, { method: "POST" }).catch(() => {}); });
      const r = res as {
        info?: { error?: { name?: string; data?: { message?: string } }; tokens?: Record<string, unknown>; cost?: number; modelID?: string; providerID?: string };
        parts?: { type?: string; text?: string }[];
      };
      if (r.info?.error) throw new Error(`opencode (${this.spec.role}) failed: ${r.info.error.data?.message ?? r.info.error.name ?? "error"}`);
      const text = (r.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n\n");
      // Nothing streamed (events missed): hand over the whole text now.
      if (!streamed && text) onText?.(text);
      const tk = r.info?.tokens ?? {};
      const cache = (tk.cache ?? {}) as Record<string, unknown>;
      const t = { input: num(tk.input), output: num(tk.output) + num(tk.reasoning), cacheRead: num(cache.read), cacheWrite: num(cache.write) };
      return {
        text, stopReason: "end_turn", warm, raw: r.info,
        model: r.info?.providerID && r.info.modelID ? `${r.info.providerID}/${r.info.modelID}` : this.spec.model || "opencode default",
        // opencode prices the call itself (its provider keys are billed; 0 for free or subscription models).
        usage: llmUsage(t, { usd: num(r.info?.cost), billing: "api" }),
        filesTouched: files.list,
      };
    } finally {
      this.server.listen(sid, null);
      if (!this.kept) void this.server.api(`/session/${sid}`, this.dir, { method: "DELETE" }).catch(() => {});
    }
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    if (this.sessionId && (this.kept || !this.used)) void this.server.api(`/session/${this.sessionId}`, this.dir, { method: "DELETE" }).catch(() => {});
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export const AGENT_FACTORIES: Record<HarnessId, AgentFactory> = {
  "claude-code": (s, keep) => new ClaudeAgent(s, keep),
  codex: (s, keep) => new CodexAgent(s, keep),
  // Cold only, even for a thread: each request is a fresh agent (the thread replays its history).
  grok: (s) => new GrokAgent(s),
  opencode: (s, keep) => new OpencodeAgent(s, keep),
  pi: (s, keep) => new RpcAgent(s, keep),
  omp: (s, keep) => new RpcAgent(s, keep),
};

/** Harnesses whose pooled (warm) agents can become element-thread agents (`keep()`); codex needs a non-ephemeral thread. */
export const KEEPS_POOLED: ReadonlySet<HarnessId> = new Set<HarnessId>(["claude-code", "opencode", "pi", "omp"]);

/** Stop the shared Codex / opencode servers when no pool or request uses them any more. */
export function stopSharedServers(inUse: Set<HarnessId>): void {
  if (!inUse.has("codex")) CodexServer.stop();
  if (!inUse.has("opencode")) OpencodeServer.stop();
}

/** The variables `env` sets on top of the server's own (prompt inspector). */
const envOf = (env: NodeJS.ProcessEnv): string[] => Object.entries(env).filter(([k, v]) => process.env[k] !== v).map(([k, v]) => `${k}=${v}`);
const elide = (args: string[]): string[] => args.map((a) => (a.length > 60 ? "…" : /\s/.test(a) ? JSON.stringify(a) : a));

/** How an agent runs, for the prompt inspector. */
export function describeAgent(spec: AgentSpec): string {
  switch (spec.harness) {
    case "claude-code": return [...envOf(claudeEnv(spec)), "claude", ...elide(claudeArgs(spec))].join(" ");
    case "grok": return [...envOf(grokEnv(spec)), "grok", ...elide(grokArgs(spec, "…"))].join(" ");
    case "pi": case "omp": return [spec.harness, ...elide(rpcArgs(spec))].join(" ");
    case "codex":
      return `codex app-server · thread/start { model: ${spec.model || "default"}${spec.speed === "fast" ? ", serviceTier: priority" : ""}, sandbox: danger-full-access, approvalPolicy: never, ${spec.project ? "developerInstructions" : "baseInstructions"}, config: ${JSON.stringify(codexConfig(spec, ["…"]))} } → turn/start { effort: ${spec.level ?? "default"} } · on: ${onLabels(spec)}`;
    case "opencode": {
      const setup = opencodeSetup(spec);
      const env = Object.keys(setup.env).map((k) => `${k}=true `).join("");
      return `${env}opencode serve${setup.pure ? " --pure" : ""} · POST /session/:id/message { model: ${spec.model || "default"}, variant: ${spec.level ?? "default"}, system, tools: ${opencodeTools(spec).join(",") || "none"} } · permissions: allow all`;
    }
  }
}
