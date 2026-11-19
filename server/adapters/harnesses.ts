import type { DrawingAnnotation } from "../../shared/annotations.ts";
import { anthropicContent, codexInput, rpcImages, opencodeParts, assertDrawingVision } from "./drawing.ts";
// The coding-agent harnesses that run the model tiers, as agents a warm pool (warmPool.ts) can start ahead of
// time. One agent = one request with a fresh context; each harness gets there its own way:
//   claude-code  `claude -p` started with its prompt and flags, waiting for the message on stdin (stream-json)
//   codex        a thread created ahead on one shared `codex app-server` (JSON-RPC over stdio); the request is a turn
//   opencode     a session created ahead on one shared `opencode serve` (HTTP + SSE events); the request is a message
//   pi, omp      `pi|omp --mode rpc` started with its prompt and flags, waiting for a `prompt` command
//   grok         cold only: `grok -p` reads its prompt before it boots, and its ACP mode ignores our prompt and
//                tool limits, so each request spawns it
// Sessions (harnessThread.ts: element threads, the central conversation, long jobs) keep one agent across requests
// instead, on the harness's own saved session (`SessionStart`): claude-code's process stays open, codex's thread (not
// ephemeral) takes more turns, opencode's session more messages, pi/omp more prompts, grok resumes its session per
// request. A session that lost its process is resumed by id, and one can start as a fork of another; the user can
// open any of them in a terminal with the harness's own resume command (docs/API-NOTES.md, "Harness sessions").
// Every harness runs in yolo mode (no approval prompts: nobody is there to answer them). The router and the
// progress lines get an empty folder, our prompt alone and no tools. The solver in a project runs as the harness
// itself: its own prompt with ours appended, and its own tools. The tier's toggles (shared/config.ts
// HARNESS_TOGGLES; all on for the solver unless switched off) decide what else loads: shell, web, subagents, MCP
// servers, skills, hooks, plugins, instruction files; each harness below maps them to its flags, config or environment.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { NativeHarnessProcess } from "./nativeProcess.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative } from "node:path";
import { HARNESS_TOGGLES, LLM_PROVIDER_LABELS, toggleOn, type HarnessId, type HarnessToggleId, type HarnessToggles, type LlmSpeed, type LlmTier } from "../../shared/config.ts";
import { priceOf, tokenCost } from "../prices.ts";
import { CLAUDE_BASE_ARGS, CliAgent, EMPTY_CWD, type CliRole } from "./claudeCli.ts";
import type { EditChange } from "../changes/evidence.ts";
import type { ExecutionOutcome, WriterExecution } from "../changes/writers.ts";
import { ClaudeEditEvents } from "./claudeEditEvents.ts";
import { parseCodexEditEvent } from "./codexEditEvents.ts";
import { opencodeEditEvent } from "./opencodeEditEvents.ts";
import { createRpcEditEventParser } from "./rpcEditEvents.ts";

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
  /** Commit drafting must not inherit harness tools or use its normal chat agent. */
  commitMessage?: boolean;
  system: string;
  /** The solver's project folder, worked in with file tools. Omitted: an empty folder, no tools. */
  project?: string;
  /**
   * Its conversation is saved by the harness (a session's agent, or a pooled one that can become one). Left out:
   * nothing is kept (one request, then gone).
   */
  persist?: boolean;
}

/** The tier each role runs on. */
export const ROLE_TIER: Record<CliRole, LlmTier> = { router: "fast", fillers: "fast", solver: "smart" };

/**
 * A harness's own saved session: what its resume command takes (`claude --resume <id>`, `codex resume <id>`,
 * `grok -r <id>`, `opencode -s <id>`, `pi|omp --session <file>`), in the project folder.
 */
export interface SessionRef {
  id: string;
  /** pi / omp: the session's file. */
  file?: string;
}

/** How a session's agent starts: a new saved session, an existing one continued, or a new one with another's history. */
export type SessionStart = { kind: "new" } | { kind: "resume"; ref: SessionRef } | { kind: "fork"; ref: SessionRef };

/** The session to resume or fork couldn't be attached (gone, or the harness refused): nothing was sent to it. */
export class SessionUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "SessionUnavailableError"; }
}

export const STOP_CONFIRM_MS = 30_000;

/** One native request owns its event sink until its protocol confirms the writer cannot write again. */
export class HarnessTurn {
  private readonly execution?: WriterExecution;
  readonly reportsEdits: boolean;
  private timeout?: ReturnType<typeof setTimeout>;
  private forceStop?: () => boolean | void | Promise<boolean | void>;
  private barrier?: Promise<void>;
  private confirmed = false;
  private reason?: ExecutionOutcome;

  constructor(execution?: WriterExecution) {
    this.execution = execution;
    this.reportsEdits = !!execution?.folder;
  }

  get stopping(): boolean { return this.reason !== undefined || !!this.execution?.stopRequested; }
  get settled(): Promise<void> | undefined { return this.barrier; }

  holdUntil(terminal: Promise<unknown>, forceStop?: () => boolean | void | Promise<boolean | void>): void {
    this.forceStop = forceStop;
    const confirm = () => {
      this.confirmed = true;
      clearTimeout(this.timeout);
    };
    this.barrier = terminal.then(confirm, confirm);
    this.execution?.waitForSettlement(this.barrier);
    this.arm();
  }

  stop(reason: ExecutionOutcome = "stopped"): void {
    if (this.confirmed) return;
    this.reason ??= reason;
    this.execution?.stopping(reason);
    this.arm();
  }

  expectConfirmation(): void { this.arm(true); }

  uncertain(reason: string): void {
    clearTimeout(this.timeout);
    this.execution?.unconfirmed(reason);
  }

  private arm(expected = false): void {
    if (this.confirmed || (!this.stopping && !expected) || !this.barrier || this.timeout) return;
    this.timeout = setTimeout(() => {
      if (this.forceStop) {
        void Promise.resolve().then(this.forceStop).then((stopped) => {
          if (stopped === false && !this.confirmed) this.execution?.unconfirmed("Vizzo could not verify that the harness process group stopped");
        }, () => this.execution?.unconfirmed("Vizzo could not verify that the harness process group stopped"));
      } else this.execution?.unconfirmed();
    }, STOP_CONFIRM_MS).unref();
  }

  async prepare(native: NativeHarnessProcess, requiresNativeConfirmation = false): Promise<void> {
    this.checkBeforeSend();
    await native.prepare(this.execution ? (identity) => this.execution!.bindNative(identity, requiresNativeConfirmation) : undefined);
    this.checkBeforeSend();
  }

  checkBeforeSend(): void {
    if (this.stopping) throw Object.assign(new Error("Solver request stopped before dispatch"), { name: "AbortError" });
  }

  edits(batch: { sessionId: string; toolCallId: string; changes: EditChange[] }): void {
    if (!this.confirmed) this.execution?.edits(batch.sessionId, batch.toolCallId, batch.changes);
  }
}

export interface WarmAgent {
  /** False once used, killed or crashed: the pool drops it. */
  alive(): boolean;
  /** Start-up finished: a request now doesn't wait for it. */
  ready(): boolean;
  request(user: string, onText: ((d: string) => void) | undefined, timeoutMs: number, annotations?: readonly DrawingAnnotation[], turn?: HarnessTurn): Promise<HarnessResult>;
  kill(): void;
  /** Finish releasing a saved session's native connection before a terminal can attach. */
  release?(): Promise<void>;
  /**
   * Sessions: from now on a request doesn't end the session, the next one continues it. Only on a pooled agent not
   * used yet whose conversation is saved (AgentSpec.persist); false = can't (the caller makes a new agent instead).
   */
  keep?(): boolean;
  /** A session's agent: the harness's own session, once it exists (after the first request at the latest). */
  session?(): SessionRef | undefined;
  /** Kept agents: stop the in-flight request (its request() rejects). Without it, kill() is used (session lost). */
  abort?(): void;
  /**
   * The process this agent alone runs in, while it runs (RAM per thread). Absent: none of its own (codex and
   * opencode share one server process; grok runs a process per request only).
   */
  pid?(): number | undefined;
}

/** Makes an agent; `start`: a session's agent from the start (new, resumed or forked). */
export type AgentFactory = (spec: AgentSpec, start?: SessionStart) => WarmAgent;

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
const on = (spec: AgentSpec, id: HarnessToggleId): boolean => !spec.commitMessage && toggleOn(spec.harness, spec.toggles, id, ROLE_TIER[spec.role]);
/**
 * The solver in a project runs as the harness itself: its own system prompt with ours appended, and its own tools
 * minus what the toggles switch off and what can't work with nobody at the keyboard. Everything else (router,
 * progress lines, a solver without a project) gets our prompt alone and only the tools its toggles name.
 */
const native = (spec: AgentSpec): boolean => spec.role === "solver" && !!spec.project;
/** The request failed before the session was attached: a resume or fork that didn't take. */
/**
 * `e` as a SessionUnavailableError when it is a resume or fork that didn't take: the CLI exited before it attached
 * the session (CliAgent's `exitedEarly`, before its init event). Anything else (a time limit, a stop, a failed
 * turn) stays as it is.
 */
const unavailable = (start: SessionStart | undefined, attached: boolean, e: unknown): unknown =>
  start && start.kind !== "new" && !attached && (e as { exitedEarly?: boolean } | null)?.exitedEarly
    ? new SessionUnavailableError(`couldn't ${start.kind} session ${start.ref.id}: ${e instanceof Error ? e.message : String(e)}`)
    : e;
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
    new Promise<T>((_, reject) => { timer = setTimeout(() => { onTimeout(); reject(Object.assign(new Error(`${label} timed out after ${ms} ms`), { name: "TimeoutError" })); }, ms); }),
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

/** The solver's tools in the project folder when it has no shell, and the secrets it may never touch. */
const CLAUDE_FILE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];
const CLAUDE_DENY = ["Read(.env*)", "Edit(.env*)"];
const CLAUDE_GIT_DENY = ["add", "stage", "commit", "stash", "reset", "checkout", "switch", "push"].map((command) => `Bash(git ${command}:*)`);
/** The built-in tools each toggle switches (`Agent` is the subagent tool's older name). */
const CLAUDE_TOGGLE_TOOLS: Partial<Record<HarnessToggleId, string[]>> = {
  shell: ["Bash"], web: ["WebSearch", "WebFetch"], subagents: ["Task", "Agent", "ListAgents", "SendMessage", "TaskStop", "Workflow"], skills: ["Skill"],
};
/**
 * Built-in tools the solver never gets: they move the work to another folder (the page shows the project folder) or
 * wake the agent later, when no request is listening (a kept process would answer into the next request).
 */
const CLAUDE_NEVER = ["EnterWorktree", "ExitWorktree", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "Monitor"];

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

/**
 * A saved session's flags: a new one under `id`, an existing one resumed, or a fork of one (its id comes with the
 * first event). Without `session` nothing is saved.
 */
export function claudeSessionArgs(session?: { start: SessionStart; id?: string }): string[] {
  if (!session) return ["--no-session-persistence"];
  const { start } = session;
  if (start.kind === "resume") return ["--resume", start.ref.id];
  if (start.kind === "fork") return ["--resume", start.ref.id, "--fork-session"];
  return session.id ? ["--session-id", session.id] : [];
}

export function claudeArgs(spec: AgentSpec, plugins: () => string[] = claudePlugins, session?: { start: SessionStart; id?: string }): string[] {
  const full = native(spec);
  // Not native: only the tools named (the file tools in a project, plus the toggles').
  const tools = [
    ...(spec.project ? CLAUDE_FILE_TOOLS : []), ...(on(spec, "shell") ? ["Bash"] : []),
    ...(on(spec, "web") ? ["WebSearch", "WebFetch"] : []), ...(on(spec, "subagents") ? ["Agent"] : []),
  ];
  // Native: Claude Code's default set, minus the toggles that are off (without Bash it brings Glob and Grep itself).
  const denied = [
    ...CLAUDE_NEVER,
    ...Object.entries(CLAUDE_TOGGLE_TOOLS).flatMap(([id, t]) => (on(spec, id as HarnessToggleId) ? [] : t)),
    ...CLAUDE_DENY, ...CLAUDE_GIT_DENY,
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
    ...claudeSessionArgs(session),
    ...(custom ? [] : ["--safe-mode"]),
    ...(on(spec, "mcp") ? [] : ["--strict-mcp-config"]),
    // --safe-mode still loads the bundled skills.
    ...(on(spec, "skills") ? [] : ["--disable-slash-commands"]),
    ...(full ? ["--tools", "default", "--disallowedTools", ...denied] : ["--tools", ...(tools.length ? tools : [""])]),
    "--dangerously-skip-permissions",
    ...(!full && spec.project ? ["--disallowedTools", ...CLAUDE_DENY] : []),
    ...(spec.model ? ["--model", spec.model] : []),
    ...(spec.level ? ["--effort", spec.level] : []),
    ...(Object.keys(settings).length ? ["--settings", JSON.stringify(settings)] : []),
    // Native: ours goes after Claude Code's own prompt (which explains its tools); else ours is all there is.
    full ? "--append-system-prompt" : "--system-prompt", spec.system,
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
  private kept: boolean;
  /** The conversation is saved: a session's agent, or a pooled one that can become one. */
  private readonly saved: boolean;
  private readonly sessionId: string | undefined;
  constructor(private spec: AgentSpec, private start?: SessionStart) {
    this.kept = !!start;
    this.saved = !!start || !!spec.persist;
    const begin: SessionStart = start ?? { kind: "new" };
    this.sessionId = !this.saved ? undefined : begin.kind === "resume" ? begin.ref.id : begin.kind === "new" ? randomUUID() : undefined;
    this.cli = new CliAgent(
      spec.role, binOrThrow("claude-code"),
      claudeArgs(spec, claudePlugins, this.saved ? { start: begin, id: this.sessionId } : undefined), cwdOf(spec), claudeEnv(spec),
    );
  }
  alive(): boolean { return (this.kept || !this.used) && !this.cli.exited; }
  // claude -p prints nothing until it gets the message: count it as booted after a typical start-up.
  ready(): boolean { return performance.now() - this.cli.spawnedAt > 800; }
  keep(): boolean { if (this.used || !this.saved) return false; this.kept = true; return true; }
  /** Known from the first event on (a fork's id only then); nothing is on disk before the first message. */
  session(): SessionRef | undefined {
    const id = this.cli.sessionId ?? this.sessionId;
    return this.saved && id && (this.used || this.start?.kind === "resume") ? { id } : undefined;
  }
  async request(user: string, onText: ((d: string) => void) | undefined, timeoutMs: number, annotations?: readonly DrawingAnnotation[], turn = new HarnessTurn()): Promise<HarnessResult> {
    this.used = true;
    const warm = this.ready();
    const files = new FilesTouched(this.spec.project);
    const edits = turn.reportsEdits ? new ClaudeEditEvents() : undefined;
    const onEvent = (ev: Record<string, unknown>): void => {
      for (const f of claudeEditedFiles(ev)) files.add(f);
      for (const batch of edits?.accept(ev) ?? []) turn.edits(batch);
    };
    let r;
    try {
      r = await this.cli.request(anthropicContent(user, annotations), { onText, onEvent, turn }, timeoutMs, warm, this.kept);
    } catch (e) {
      throw unavailable(this.start, this.cli.attached, e);
    }
    return {
      text: r.text, stopReason: r.stopReason, model: r.model ?? this.spec.model, usage: r.usage, warm,
      raw: { ...r.raw, cliCostUsd: r.cliCostUsd, cliDurationMs: r.durationMs }, filesTouched: files.list,
    };
  }
  pid(): number | undefined { return this.cli.exited ? undefined : this.cli.pid; }
  /** Stops the turn; the process and its conversation stay (CliAgent.interrupt). */
  abort(): void { this.cli.interrupt(); }
  kill(): void { this.cli.kill(); }
}

// ── Grok (cold) ──────────────────────────────────────────────────────────────

/** Grok's built-in tools: without a native solver, the file tools and the toggles' are allowed, the rest removed. */
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
/** Tools the native solver never gets: they wait for a person, wake the agent later, or write to xAI. */
const GROK_NEVER = ["ask_user_question", "enter_plan_mode", "exit_plan_mode", "send_feedback", "scheduler_create", "scheduler_delete", "scheduler_list", "monitor"];

/** The built-in tools removed for `spec`. */
export function grokDisallowed(spec: AgentSpec): string[] {
  const toggled = new Set(Object.entries(GROK_TOGGLE_TOOLS).flatMap(([id, tools]) => (on(spec, id as HarnessToggleId) ? tools : [])));
  if (native(spec)) {
    // Grok's own set, minus the toggles that are off (a tool two toggles share goes when both are off).
    const off = Object.values(GROK_TOGGLE_TOOLS).flat().filter((t) => !toggled.has(t));
    return [...new Set([...GROK_NEVER, ...off])];
  }
  const allowed = new Set([...(spec.project ? GROK_FILE_TOOLS : []), ...toggled]);
  return GROK_TOOLS.filter((t) => !allowed.has(t));
}

/**
 * `session`: a saved session's request. The first one starts it under `id` (-s) or as a fork of another (-r with
 * --fork-session); later ones resume it (-r). A resumed session keeps the rules it started with (checked live,
 * docs/API-NOTES.md), so they are only sent when it starts.
 */
export function grokArgs(spec: AgentSpec, user: string, session?: { id: string; mode: "new" | "resume" | "fork" }): string[] {
  const disallowed = grokDisallowed(spec);
  const tools = native(spec) || disallowed.length < GROK_TOOLS.length;
  const starts = !session || session.mode === "new";
  return [
    "-p", user, "--output-format", "streaming-messages-json", "--include-partial-messages",
    ...(session ? (session.mode === "new" ? ["-s", session.id] : ["-r", session.id, ...(session.mode === "fork" ? ["--fork-session"] : [])]) : []),
    ...(spec.model ? ["-m", spec.model] : []), ...(spec.level ? ["--reasoning-effort", spec.level] : []),
    "--always-approve", ...(on(spec, "web") ? [] : ["--disable-web-search"]), ...(on(spec, "subagents") ? [] : ["--no-subagents"]), "--no-plan",
    // With tools, --rules appends to Grok's own prompt (which explains them); without, ours replaces it.
    ...(tools
      ? [...(starts ? ["--rules", spec.system] : []), ...(spec.project ? ["--cwd", spec.project] : []), ...(native(spec) ? [] : ["--max-turns", "40"])]
      : [...(starts ? ["--system-prompt-override", spec.system] : []), "--max-turns", "1"]),
    ...(spec.commitMessage ? ["--tools="] : []),
    `--disallowed-tools=${disallowed.join(",")}`,
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

/**
 * Cold: each request is a new `grok -p`. A session's agent (`start`) runs every request on one saved Grok session:
 * the first starts it (or forks another), the rest resume it, so Grok keeps its own context between them.
 */
class GrokAgent implements WarmAgent {
  private used = false;
  private killed = false;
  private cli: CliAgent | null = null;
  private sessionId: string | undefined;
  /** The session exists on Grok's side (its first request got as far as the init event). */
  private started: boolean;
  constructor(private spec: AgentSpec, private start?: SessionStart) {
    binOrThrow("grok");
    this.started = start?.kind === "resume";
    this.sessionId = start?.kind === "new" ? randomUUID() : start?.ref.id;
  }
  alive(): boolean { return this.start ? !this.killed : !this.used; }
  ready(): boolean { return false; }
  session(): SessionRef | undefined { return this.start && this.started && this.sessionId ? { id: this.sessionId } : undefined; }
  async request(user: string, onText: ((d: string) => void) | undefined, timeoutMs: number, annotations?: readonly DrawingAnnotation[], turn = new HarnessTurn()): Promise<HarnessResult> {
    turn.checkBeforeSend();
    this.used = true;
    if (annotations?.length) throw new Error("Grok CLI does not support drawing attachments. Select Codex, Claude Code, pi, omp or OpenCode for this tier.");
    let apiKeySource = "";
    const mode = !this.start ? null : this.started ? "resume" as const : this.start.kind === "fork" ? "fork" as const : "new" as const;
    const cli = new CliAgent(
      `grok ${this.spec.role}`, binOrThrow("grok"), grokArgs(this.spec, user, mode && this.sessionId ? { id: this.sessionId, mode } : undefined),
      cwdOf(this.spec), prepareGrokHome(this.spec, grokEnv(this.spec)), true,
    );
    this.cli = cli;
    let res;
    try {
      res = await cli.request(null, {
        onText, turn,
        onEvent: (ev) => { if (ev.type === "system" && ev.subtype === "init") apiKeySource = String(ev.apiKeySource ?? ""); },
      }, timeoutMs, false);
    } catch (e) {
      // A later request resumes the session it started: one that's gone counts the same as a resume that didn't take.
      throw unavailable(this.started && this.sessionId ? { kind: "resume", ref: { id: this.sessionId } } : this.start, cli.attached, e);
    } finally {
      this.cli = null;
      if (this.start && cli.attached) {
        this.started = true;
        // A fork gets its own id with the first event.
        if (cli.sessionId) this.sessionId = cli.sessionId;
      }
    }
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
  /** Stops the request's process; the saved session stays and the next request resumes it. */
  abort(): void { this.cli?.interruptProcess(); }
  kill(): void { this.killed = true; this.cli?.kill(); }
}

// ── Pi and OhMyPi (RPC mode) ─────────────────────────────────────────────────

/** Each harness's file tools (the solver's), the tools a toggle adds, and (omp) the other tools a native solver keeps. */
const RPC_TOOLS: Record<"pi" | "omp", { files: string[]; toggles: Partial<Record<HarnessToggleId, string[]>>; more: string[] }> = {
  pi: { files: ["read", "edit", "write", "grep", "find", "ls"], toggles: { shell: ["bash"] }, more: [] },
  omp: {
    files: ["read", "edit", "write", "grep", "glob", "find"],
    // omp 18 refuses `python`, `fetch`, `browser`, `notebook` and `lsp` in --tools (eval runs python; read fetches URLs).
    toggles: { shell: ["bash", "eval"], web: ["web_search"], subagents: ["task"] },
    more: ["todo"],
  },
};

/**
 * A saved session's flags: nothing for a new one (the harness names it), --session to continue one, --fork for a
 * new one with another's history. Without `start` the conversation isn't saved.
 */
function rpcSessionArgs(start?: SessionStart): string[] {
  if (!start) return ["--no-session"];
  if (start.kind === "new") return [];
  return [start.kind === "resume" ? "--session" : "--fork", start.ref.file ?? start.ref.id];
}

export function rpcArgs(spec: AgentSpec, start?: SessionStart): string[] {
  const t = RPC_TOOLS[spec.harness === "omp" ? "omp" : "pi"];
  const full = native(spec);
  const toggled = Object.entries(t.toggles).flatMap(([id, x]) => (on(spec, id as HarnessToggleId) ? x : []));
  // Native with every tool toggle on: the harness's own set (with its extensions' tools), so no list at all. The
  // list is an allowlist (pi's covers extension tools too), so it is only given when something has to stay out.
  const everything = full && Object.keys(t.toggles).every((id) => on(spec, id as HarnessToggleId));
  const tools = [...(spec.project ? t.files : []), ...(full ? t.more : []), ...toggled];
  const common = [
    "--mode", "rpc", ...rpcSessionArgs(start ?? (spec.persist ? { kind: "new" } : undefined)),
    ...(on(spec, "plugins") ? [] : ["--no-extensions"]), ...(on(spec, "skills") ? [] : ["--no-skills"]),
    ...(spec.model ? ["--model", spec.model] : []), ...(spec.level ? ["--thinking", spec.level] : []),
    // Native: ours goes after the harness's own prompt. A resumed session gets it again (omp doesn't keep it).
    full ? "--append-system-prompt" : "--system-prompt", spec.system,
  ];
  const list = (flag: (names: string) => string[]): string[] => (everything ? [] : tools.length ? flag(tools.join(",")) : ["--no-tools"]);
  if (spec.harness === "omp") {
    return [
      ...common, ...(on(spec, "instructions") ? [] : ["--no-rules"]), ...(full ? [] : ["--no-lsp"]), "--approval-mode=yolo",
      // OpenAI's priority tier; on Anthropic models omp sends Opus fast mode (speed: fast + its beta) instead.
      ...(spec.speed === "fast" ? ["--service-tier", "priority"] : []),
      ...list((names) => [`--tools=${names}`]),
    ];
  }
  // Pi has no approval prompts: it runs whatever its tools do.
  return [...common, ...(on(spec, "instructions") ? [] : ["--no-context-files"]), ...list((names) => ["--tools", names])];
}

/** What `get_state` answers (the parts used). */
interface RpcState { model?: { input?: string[] }; sessionId?: string; sessionFile?: string; messageCount?: number }
/** Extension UI requests that wait for an answer (the others only show something). */
const RPC_DIALOGS = new Set(["select", "confirm", "input", "editor"]);

class RpcAgent implements WarmAgent {
  private native: NativeHarnessProcess;
  private proc: ChildProcessWithoutNullStreams;
  private exited = false;
  private used = false;
  private booted = false;
  private kept: boolean;
  /** The conversation is saved: a session's agent, or a pooled one that can become one. */
  private readonly saved: boolean;
  private state: RpcState | null = null;
  private resolveBoot!: (state: RpcState | null) => void;
  private bootState = new Promise<RpcState | null>(resolve => { this.resolveBoot = resolve; });
  private stderr = "";
  private listener: ((ev: Record<string, unknown>) => void) | null = null;
  private exitWaiters: ((code: number | null) => void)[] = [];

  // A session's agent keeps its conversation in the harness's own session file (nothing is written before the
  // first message); without one, --no-session keeps it in memory only.
  constructor(private spec: AgentSpec, private start?: SessionStart) {
    this.kept = !!start;
    this.saved = !!start || !!spec.persist;
    // A session file that's gone would be started empty under the same name: say so instead.
    if (start && start.kind !== "new" && start.ref.file && !existsSync(start.ref.file)) {
      throw new SessionUnavailableError(`couldn't ${start.kind} session ${start.ref.id}: ${start.ref.file} is gone`);
    }
    this.native = new NativeHarnessProcess(binOrThrow(spec.harness), rpcArgs(spec, start), cwdOf(spec));
    this.proc = this.native.proc;
    this.proc.stdin.on("error", () => { /* Process close is the terminal signal. */ });
    jsonLines(this.proc, (ev) => {
      if (ev.type === "response" && ev.id === "boot") {
        this.booted = true;
        this.state = (ev.data as RpcState | undefined) ?? null;
        this.resolveBoot(this.state);
        return;
      }
      // An extension asking the user something (select, confirm, input, editor): nobody is there, so it's dismissed.
      if (ev.type === "extension_ui_request" && typeof ev.id === "string" && RPC_DIALOGS.has(String(ev.method))) {
        this.proc.stdin.write(JSON.stringify({ type: "extension_ui_response", id: ev.id, cancelled: true }) + "\n");
        return;
      }
      this.listener?.(ev);
    });
    this.proc.stderr.on("data", (d: Buffer) => { this.stderr = (this.stderr + d.toString()).slice(-2000); });
    void this.native.closed.then((code) => { this.exited = true; this.resolveBoot(null); for (const w of this.exitWaiters) w(code); });
    this.proc.on("error", (e) => { this.exited = true; this.resolveBoot(null); this.stderr += String(e); });
    // Answered once the agent has loaded its models and tools: that's "booted".
    this.proc.stdin.write(JSON.stringify({ id: "boot", type: "get_state" }) + "\n");
  }

  alive(): boolean { return (this.kept || !this.used) && !this.exited; }
  ready(): boolean { return this.booted; }
  keep(): boolean { if (this.used || !this.saved) return false; this.kept = true; return true; }
  abort(): void { if (!this.exited) this.proc.stdin.write(JSON.stringify({ id: "abort", type: "abort" }) + "\n"); }
  pid(): number | undefined { return this.exited ? undefined : this.native.nativePid; }
  /** From the boot state; the file is written with the first message. */
  session(): SessionRef | undefined {
    const id = this.state?.sessionId;
    if (!this.saved || !id || !(this.used || this.start?.kind === "resume")) return undefined;
    return { id, ...(this.state?.sessionFile ? { file: this.state.sessionFile } : {}) };
  }

  async request(user: string, onText: ((d: string) => void) | undefined, timeoutMs: number, annotations?: readonly DrawingAnnotation[], turn = new HarnessTurn()): Promise<HarnessResult> {
    const first = !this.used;
    this.used = true;
    const warm = this.booted;
    if (first && this.start && this.start.kind !== "new") {
      // The session to continue has to be there with its history: an empty one means it wasn't found.
      const start = this.start;
      const state = await withTimeout(this.bootState, Math.min(timeoutMs, 30_000), `${this.spec.harness} session`, () => this.kill()).catch(() => null);
      if (!state || !state.messageCount) {
        this.kill();
        throw new SessionUnavailableError(`couldn't ${start.kind} session ${start.ref.id}: ${this.stderr.trim().slice(-200) || "it came up empty"}`);
      }
    }
    if (annotations?.length) {
      try {
        const state = await withTimeout(this.bootState, Math.min(timeoutMs, 15_000), `${this.spec.harness} image capabilities`, () => this.kill());
        assertDrawingVision(state?.model?.input?.includes("image"), this.spec.harness, this.spec.model);
      } catch (err) { this.kill(); throw err; }
    }
    await turn.prepare(this.native);
    const files = new FilesTouched(this.spec.project);
    const edits = turn.reportsEdits && this.spec.harness === "omp" ? createRpcEditEventParser("omp") : undefined;
    const label = `${this.spec.harness} (${this.spec.role})`;
    let text = "";
    let model = this.spec.model;
    let provider = "";
    let stopReason: string | null = null;
    let failure = "";
    let cost = 0;
    let last: unknown = null;
    const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let confirmTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => { confirmTerminal = resolve; });
    const done = new Promise<void>((resolve, reject) => {
      this.exitWaiters = [(code) => {
        confirmTerminal();
        reject(new Error(`${label} exited (${code}) before answering: ${this.stderr.trim().slice(-300)}`));
      }];
      this.listener = (ev) => {
        for (const f of rpcEditedFiles(ev)) files.add(f);
        const batch = edits?.(ev);
        const sessionId = this.state?.sessionId;
        if (batch && sessionId) turn.edits({ ...batch, sessionId });
        const ame = ev.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (ev.type === "message_update" && ame?.type === "text_delta" && ame.delta) {
          text += ame.delta;
          if (!turn.stopping) onText?.(ame.delta);
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
        } else if (ev.type === "response" && ev.id === "prompt" && ev.success === false) {
          reject(new Error(`${label}: ${String(ev.error ?? "prompt rejected")}`));
        } else if (ev.type === "agent_end") {
          confirmTerminal();
          resolve();
        }
      };
    });
    const cleanup = async () => {
      if (turn.stopping) {
        if (!this.kept) this.proc.stdin.end();
        // A rejected RPC can finish the request without proving that an interrupted turn ended.
        await terminal;
        await this.native.waitForStoppedTurn(this.kept);
      } else if (!this.kept) this.kill();
      this.listener = null;
      this.exitWaiters = [];
    };
    turn.holdUntil(done.then(cleanup, cleanup), () => this.native.stop(true));
    this.proc.stdin.write(JSON.stringify({ id: "prompt", type: "prompt", message: user, ...(annotations?.length ? { images: rpcImages(annotations) } : {}) }) + "\n");
    await withTimeout(done, timeoutMs, label, () => { turn.stop("timed-out"); this.abort(); });
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

  kill(): void { if (!this.exited) void this.native.stop(); }
}

// ── Codex (shared app-server, one thread per request) ────────────────────────

type Notify = (method: string, params: Record<string, unknown>) => void;

/** One `codex app-server` (JSON-RPC over stdio) shared by every Codex agent. */
class CodexServer {
  private static current: CodexServer | null = null;
  private static retiring = new Set<CodexServer>();
  static get(): CodexServer {
    if (!CodexServer.current || CodexServer.current.exited) CodexServer.current = new CodexServer();
    return CodexServer.current;
  }
  static async stop(force = false): Promise<void> {
    if (CodexServer.current) CodexServer.retiring.add(CodexServer.current);
    CodexServer.current = null;
    await Promise.all([...CodexServer.retiring].map(async (server) => {
      if (!await server.native.stop(force)) {
        if (force) throw new Error("Vizzo could not verify that the Codex process group stopped");
        return;
      }
      await server.closed;
      CodexServer.retiring.delete(server);
    }));
  }

  readonly native: NativeHarnessProcess;
  private proc: ChildProcessWithoutNullStreams;
  private id = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private threads = new Map<string, Notify>();
  private closedWaiters = new Map<string, Set<() => void>>();
  private stderr = "";
  exited = false;
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  /** The MCP servers in the user's config: a thread with MCP off turns each one off (an empty table merges). */
  readonly mcpServers: Promise<string[]>;

  private constructor() {
    mkdirSync(EMPTY_CWD, { recursive: true });
    // What a thread loads is set per thread (codexConfig): the server starts with the user's config.
    this.native = new NativeHarnessProcess(binOrThrow("codex"), ["app-server"], EMPTY_CWD);
    this.proc = this.native.proc;
    this.proc.stdin.on("error", () => { /* Process close is the terminal signal. */ });
    jsonLines(this.proc, (m) => this.onMessage(m));
    this.proc.stderr.on("data", (d: Buffer) => { this.stderr = (this.stderr + d.toString()).slice(-2000); });
    this.closed = this.native.closed.then((code) => {
      this.exited = true;
      const err = new Error(`codex app-server exited (${code}): ${this.stderr.trim().slice(-300)}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      for (const waiters of this.closedWaiters.values()) for (const done of waiters) done();
      this.closedWaiters.clear();
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
    if (tid && m.method === "thread/closed") {
      for (const done of this.closedWaiters.get(tid) ?? []) done();
      this.closedWaiters.delete(tid);
    }
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

  async releaseThread(threadId: string): Promise<void> {
    if (this.exited) return;
    let done!: () => void;
    const closed = new Promise<void>((resolve) => { done = resolve; });
    const waiters = this.closedWaiters.get(threadId) ?? new Set<() => void>();
    waiters.add(done);
    this.closedWaiters.set(threadId, waiters);
    try {
      await withTimeout((async () => {
        const r = await this.call("thread/unsubscribe", { threadId }) as { status?: string };
        // Unsubscribe only removes the subscription. The writer lock stays until thread/closed.
        if (r.status !== "notLoaded") await closed;
      })(), 10_000, "Releasing the Codex session for terminal resume", () => {});
    } catch (e) {
      if (!this.exited) throw e;
    } finally {
      waiters.delete(done);
      if (!waiters.size) this.closedWaiters.delete(threadId);
    }
  }
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
  private active?: Promise<void>;
  private releasing: Promise<void> | null = null;

  private readonly kept: boolean;

  /**
   * `start`: a session's agent, on a thread Codex saves (not ephemeral: it takes turn after turn): a new one, a
   * saved one resumed (thread/resume) or a fork of one (thread/fork). Pooled agents can't become one.
   */
  constructor(private spec: AgentSpec, private start?: SessionStart) {
    this.kept = !!start;
    this.thread = this.server.mcpServers.then((mcp) => {
      const common = {
        ...(spec.model ? { model: spec.model } : {}),
        // No grace period after unsubscribe: the user may be taking this session over in a terminal.
        config: { ...codexConfig(spec, mcp), thread_unload_delay_secs: 0 },
        ...(spec.speed === "fast" ? { serviceTier: "priority" } : {}),
        cwd: cwdOf(spec), approvalPolicy: "never", sandbox: "danger-full-access",
        // The router's prompt replaces Codex's own; the solver keeps Codex's (it explains the tools) with ours added.
        ...(spec.project ? { developerInstructions: spec.system } : { baseInstructions: spec.system }),
      };
      if (start?.kind === "resume") return this.server.call("thread/resume", { ...common, threadId: start.ref.id, excludeTurns: true });
      if (start?.kind === "fork") return this.server.call("thread/fork", { ...common, threadId: start.ref.id, ephemeral: false, excludeTurns: true });
      return this.server.call("thread/start", { ...common, ephemeral: !start });
    }).then((r) => (this.threadId = (r as { thread: { id: string } }).thread.id));
    this.thread.catch(() => { this.failed = true; });
  }

  session(): SessionRef | undefined {
    return this.kept && this.threadId && (this.used || this.start?.kind === "resume") ? { id: this.threadId } : undefined;
  }

  alive(): boolean { return (this.kept || !this.used) && !this.failed && !this.server.exited; }
  ready(): boolean { return this.threadId !== null; }
  abort(): void { this.interrupt(); }
  private interrupt(): void {
    if (this.threadId && this.turnId) void this.server.call("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
  }

  async request(user: string, onText: ((d: string) => void) | undefined, timeoutMs: number, annotations?: readonly DrawingAnnotation[], turn = new HarnessTurn()): Promise<HarnessResult> {
    this.used = true;
    const warm = this.threadId !== null;
    const label = `codex (${this.spec.role})`;
    const start = this.start;
    const threadId = await this.thread.catch((e: unknown) => {
      // The app server refused the thread to resume or fork: nothing was sent to it.
      if (start && start.kind !== "new" && !this.server.exited) throw new SessionUnavailableError(`couldn't ${start.kind} session ${start.ref.id}: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    });
    await turn.prepare(this.server.native);
    const files = new FilesTouched(this.spec.project);
    let text = "";
    let usage: Record<string, unknown> = {};
    let finalTurn: unknown = null;
    let respond!: () => void;
    let fail!: (error: Error) => void;
    let settle!: () => void;
    const done = new Promise<void>((resolve, reject) => { respond = resolve; fail = reject; });
    done.catch(() => {});
    const terminal = new Promise<void>((resolve) => { settle = resolve; });
    const early: { method: string; params: Record<string, unknown> }[] = [];
    let matchingTurn: string | null = null;
    const receive: Notify = (method, params) => {
      if (method === "server/exited") {
        turn.stop("interrupted");
        settle();
        fail(new Error(String(params.message)));
        return;
      }
      if (!matchingTurn) {
        if (early.length < 256) early.push({ method, params });
        return;
      }
      const nativeTurn = params.turn as { id?: string; status?: string; error?: { message?: string } | null } | undefined;
      const notificationTurn = params.turnId ?? nativeTurn?.id;
      if (notificationTurn !== undefined && notificationTurn !== matchingTurn) return;
      if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
        text += params.delta;
        if (!turn.stopping) onText?.(params.delta);
      } else if (method === "item/completed") {
        for (const f of codexEditedFiles(params.item)) files.add(f);
        const batch = turn.reportsEdits && notificationTurn === matchingTurn ? parseCodexEditEvent(method, params) : null;
        if (batch?.sessionId === threadId) turn.edits(batch);
      } else if (method === "thread/tokenUsage/updated") {
        usage = ((params.tokenUsage as Record<string, unknown> | undefined)?.last ?? {}) as Record<string, unknown>;
      } else if (method === "turn/completed" && notificationTurn === matchingTurn) {
        finalTurn = nativeTurn;
        settle();
        if (nativeTurn?.status === "completed") respond();
        else fail(new Error(`${label} turn ${nativeTurn?.status ?? "failed"}: ${nativeTurn?.error?.message ?? ""}`));
      } else if (method === "error" && !params.willRetry) {
        turn.stop("failed");
        this.interrupt();
        fail(new Error(`${label}: ${String((params.error as { message?: string } | undefined)?.message ?? "error")}`));
      }
    };
    this.server.listen(threadId, receive);
    turn.holdUntil(terminal.then(() => {
      this.server.listen(threadId, null);
      this.turnId = null;
      this.active = undefined;
    }));
    this.active = turn.settled;
    const request = async () => {
      let started: unknown;
      try {
        started = await this.server.call("turn/start", {
          threadId, input: codexInput(user, annotations),
          ...(this.spec.level ? { effort: this.spec.level } : {}),
        });
      } catch (error) {
        // A protocol rejection of this call means there is no turn. A server exit is also terminal.
        settle();
        throw error;
      }
      const id = (started as { turn?: { id?: unknown } } | null)?.turn?.id;
      if (typeof id !== "string" || !id) {
        turn.stop("failed");
        throw new Error(`${label} returned no native turn ID`);
      }
      this.turnId = matchingTurn = id;
      for (const note of early) receive(note.method, note.params);
      early.length = 0;
      if (turn.stopping) this.interrupt();
      await done;
    };
    await withTimeout(request(), timeoutMs, label, () => { turn.stop("timed-out"); this.interrupt(); });
    // OpenAI counts cached tokens inside input.
    const cached = num(usage.cachedInputTokens);
    const t = { input: Math.max(0, num(usage.inputTokens) - cached), output: num(usage.outputTokens), cacheRead: cached };
    const model = this.spec.model || "codex default";
    const price = priceOf("codex", model);
    return {
      text, stopReason: "end_turn", model, warm, raw: { turn: finalTurn, usage }, filesTouched: files.list,
      // Priced at the standard rate (the Fast tier spends the subscription's allowance faster, not money).
      usage: llmUsage(t, { usd: price ? tokenCost(price, t) : null, billing: "subscription" }),
    };
  }

  // Ephemeral: nothing to clean up. Kept: the thread stays on disk (codex's own history, `codex resume <id>`) and
  // is let go of here: while the app server holds it, no other Codex can write to it ("already has an active
  // writer"), so the user couldn't take it over in a terminal.
  kill(): void {
    this.failed = true;
    this.interrupt();
    if (this.kept) void this.release().catch(() => {});
  }

  release(): Promise<void> {
    this.failed = true;
    return this.releasing ??= Promise.resolve(this.active).then(() => this.thread).then((id) => this.server.releaseThread(id)).catch((e: unknown) => {
      this.releasing = null;
      throw e;
    });
  }
}

// ── opencode (shared `opencode serve`, one session per request) ─────────────

/** opencode's built-in tools (GET /experimental/tool/ids). `question` waits for a person: always off. */
const OPENCODE_TOOLS = ["invalid", "question", "bash", "read", "glob", "grep", "edit", "write", "task", "webfetch", "todowrite", "websearch", "skill", "apply_patch"];
const OPENCODE_FILE_TOOLS = ["read", "glob", "grep", "edit", "write", "apply_patch"];
/** Built-in tools a native solver keeps besides its files' and its toggles'. Tools not listed here (MCP servers', plugins') are left as opencode has them. */
const OPENCODE_MORE_TOOLS = ["todowrite"];
const OPENCODE_TOGGLE_TOOLS: Partial<Record<HarnessToggleId, string[]>> = { shell: ["bash"], web: ["webfetch", "websearch"], subagents: ["task"], skills: ["skill"] };
const opencodeTools = (spec: AgentSpec): string[] => [
  ...(spec.project ? OPENCODE_FILE_TOOLS : []), ...(native(spec) ? OPENCODE_MORE_TOOLS : []),
  ...Object.entries(OPENCODE_TOGGLE_TOOLS).flatMap(([id, tools]) => (on(spec, id as HarnessToggleId) ? tools : [])),
];
/** What a server loads is set when it starts: one server per such setup (plugins off = --pure). */
interface OpencodeSetup { pure: boolean; env: Record<string, string>; config?: string }
const OPENCODE_COMMIT_AGENT = "vizzo-commit-message";
export function opencodeSetup(spec: AgentSpec): OpencodeSetup {
  return {
    pure: !on(spec, "plugins"),
    env: {
      ...(on(spec, "skills") ? {} : { OPENCODE_DISABLE_EXTERNAL_SKILLS: "true", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "true" }),
      ...(on(spec, "instructions") ? {} : { OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "true" }),
      ...(spec.commitMessage && {
        OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_EXPERIMENTAL_CODE_MODE: "false",
      }),
    },
    ...(spec.commitMessage && { config: JSON.stringify({
      agent: { [OPENCODE_COMMIT_AGENT]: { mode: "primary", permission: { "*": "deny" }, steps: 1 } },
      share: "disabled",
    }) }),
  };
}
/** Yolo: allow everything opencode would otherwise ask about. */
const OPENCODE_CONFIG = JSON.stringify({
  permission: { edit: "allow", bash: "allow", webfetch: "allow", external_directory: "allow", doom_loop: "allow" },
});

type SessionListener = (type: string, props: Record<string, unknown>) => void;

class OpencodeResponseError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

class OpencodeServer {
  private static servers = new Map<string, OpencodeServer>();
  private static retiring = new Set<OpencodeServer>();
  static get(setup: OpencodeSetup): OpencodeServer {
    const key = JSON.stringify(setup);
    let s = OpencodeServer.servers.get(key);
    if (!s || s.exited) OpencodeServer.servers.set(key, (s = new OpencodeServer(setup)));
    return s;
  }
  static async stop(force = false): Promise<void> {
    for (const current of OpencodeServer.servers.values()) OpencodeServer.retiring.add(current);
    OpencodeServer.servers.clear();
    await Promise.all([...OpencodeServer.retiring].map(async (server) => {
      // OpenCode may have started a shell in a separate group. Ask it to stop its own tools
      // before tearing down the authenticated server, and accept only its native idle event.
      if (server.sessions.size && await server.native?.verify()) {
        await withTimeout(Promise.all([...server.sessions.values()].map((session) => session.beforeRestart())),
          3_000, "Waiting for OpenCode tools to stop", () => {}).catch(() => {});
      }
      server.stopping = true;
      if (server.native && !await server.native.stop(force)) {
        if (force) throw new Error("Vizzo could not verify that the OpenCode process group stopped");
        return;
      }
      await server.closed;
      OpencodeServer.retiring.delete(server);
    }));
  }

  private native: NativeHarnessProcess | null = null;
  private readonly password = randomBytes(24).toString("hex");
  private readonly authorization = `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`;
  private stderr = "";
  private stopping = false;
  exited = false;
  readonly url: Promise<string>;
  private finishExit!: () => void;
  private readonly closed = new Promise<void>((resolve) => { this.finishExit = resolve; });
  private streams = new Map<string, AbortController>();
  private readers = new Set<Promise<void>>();
  private sessions = new Map<string, { directory: string; receive: SessionListener; beforeRestart: () => Promise<void> }>();

  private constructor(setup: OpencodeSetup) {
    mkdirSync(EMPTY_CWD, { recursive: true });
    this.url = freePort().then((port) => new Promise<string>((resolve, reject) => {
      if (this.stopping) {
        this.exited = true;
        this.finishExit();
        reject(new Error("OpenCode server was stopped before starting"));
        return;
      }
      const native = this.native = new NativeHarnessProcess(
        binOrThrow("opencode"), ["serve", "--hostname", "127.0.0.1", "--port", String(port), ...(setup.pure ? ["--pure"] : [])],
        EMPTY_CWD, { ...process.env, ...setup.env, OPENCODE_CONFIG_CONTENT: setup.config ?? OPENCODE_CONFIG,
          OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: this.password },
      );
      const { proc } = native;
      const onOut = (d: Buffer) => {
        const m = /listening on (http:\/\/\S+)/.exec(d.toString());
        if (m) resolve(m[1]!.replace(/\/$/, ""));
      };
      proc.stdout.on("data", onOut);
      proc.stderr.on("data", (d: Buffer) => { this.stderr = (this.stderr + d.toString()).slice(-2000); onOut(d); });
      void native.closed.then(async (code) => {
        this.exited = true;
        const message = `opencode serve exited (${code}): ${this.stderr.trim().slice(-300)}`;
        reject(new Error(message));
        // The process group is gone. Drain accepted SSE frames before interrupting the writers.
        await Promise.all([...this.readers]);
        for (const { receive } of this.sessions.values()) receive("server/exited", { message });
        this.sessions.clear();
        for (const controller of this.streams.values()) controller.abort();
        this.finishExit();
      });
      proc.on("error", (e) => { this.exited = true; reject(e); });
    }));
    this.url.catch(() => {
      if (!this.native) { this.exited = true; this.finishExit(); }
    });
  }

  async prepare(turn: HarnessTurn, requiresNativeConfirmation: boolean): Promise<void> {
    await this.url;
    await turn.prepare(this.native!, requiresNativeConfirmation);
  }

  /** Subscribe to the event stream of `dir` (opencode scopes sessions and events by directory), once. */
  async watch(dir: string): Promise<void> {
    if (this.streams.has(dir)) return;
    const ctl = new AbortController();
    this.streams.set(dir, ctl);
    let body: AsyncIterable<Uint8Array>;
    try {
      const res = await fetch(`${await this.url}/event?directory=${encodeURIComponent(dir)}`, { signal: ctl.signal, headers: { authorization: this.authorization } });
      if (!res.ok || !res.body) throw new Error(`opencode /event ${res.status}`);
      body = res.body as unknown as AsyncIterable<Uint8Array>;
    } catch (error) {
      this.streams.delete(dir);
      throw error;
    }
    const reader = (async () => {
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
            if (sid) {
              const listener = this.sessions.get(sid);
              if (listener?.directory === dir) listener.receive(ev.type ?? "", props);
            }
          }
        }
      } catch { /* reconnect below while this directory still has an active turn */ }
      this.streams.delete(dir);
      this.reconnect(dir);
    })();
    this.readers.add(reader);
    void reader.then(() => this.readers.delete(reader));
  }

  private reconnect(directory: string): void {
    if (this.exited || this.stopping || ![...this.sessions.values()].some((session) => session.directory === directory)) return;
    setTimeout(() => {
      if (this.exited || this.stopping) return;
      void this.watch(directory).catch(() => this.reconnect(directory));
    }, 250).unref();
  }

  listen(sessionId: string, fn: SessionListener | null, directory = "", beforeRestart = async () => {}): void {
    if (fn) this.sessions.set(sessionId, { directory, receive: fn, beforeRestart });
    else this.sessions.delete(sessionId);
  }

  async api(path: string, dir: string, init: { method: string; body?: unknown }): Promise<unknown> {
    const res = await fetch(`${await this.url}${path}?directory=${encodeURIComponent(dir)}`, {
      method: init.method, headers: { "content-type": "application/json", authorization: this.authorization }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!res.ok) throw new OpencodeResponseError(`opencode ${init.method} ${path} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`, res.status);
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

let lastOpencodeTime = 0;
let opencodeSequence = 0;

/** OpenCode sorts ascending message IDs by their timestamp and counter bytes. */
function opencodeMessageId(): string {
  const now = Date.now();
  opencodeSequence = now === lastOpencodeTime ? (opencodeSequence + 1) % 4096 : 1;
  lastOpencodeTime = now;
  const prefix = ((BigInt(now) * 4096n + BigInt(opencodeSequence)) & 0xffffffffffffn).toString(16).padStart(12, "0");
  return `msg_${prefix}${randomUUID().replaceAll("-", "").slice(0, 14)}`;
}

class OpencodeAgent implements WarmAgent {
  private server: OpencodeServer;
  private dir: string;
  private sessionP: Promise<string>;
  private sessionId: string | null = null;
  private used = false;
  private failed = false;
  private killed = false;
  private kept: boolean;

  /**
   * `start`: a session's agent. opencode saves every session; a new one is created, a saved one looked up (it has
   * to be there), or a fork of one made (POST /session/:id/fork).
   */
  constructor(private spec: AgentSpec, private start?: SessionStart) {
    this.kept = !!start;
    this.server = OpencodeServer.get(opencodeSetup(spec));
    this.dir = cwdOf(spec);
    const open = (): Promise<unknown> =>
      start?.kind === "resume" ? this.server.api(`/session/${start.ref.id}`, this.dir, { method: "GET" })
        : start?.kind === "fork" ? this.server.api(`/session/${start.ref.id}/fork`, this.dir, { method: "POST", body: {} })
          : this.server.api("/session", this.dir, { method: "POST", body: spec.commitMessage ? { title: "Vizzo commit message" } : {} });
    this.sessionP = this.server.watch(this.dir).then(open).then((s) => (this.sessionId = (s as { id: string }).id));
    this.sessionP.catch(() => { this.failed = true; });
  }

  session(): SessionRef | undefined {
    return this.kept && this.sessionId && (this.used || this.start?.kind === "resume") ? { id: this.sessionId } : undefined;
  }

  alive(): boolean { return (this.kept || !this.used) && !this.failed && !this.killed && !this.server.exited; }
  ready(): boolean { return this.sessionId !== null; }
  keep(): boolean { if (this.used) return false; this.kept = true; return true; }
  abort(): void { if (this.sessionId) void this.server.api(`/session/${this.sessionId}/abort`, this.dir, { method: "POST" }).catch(() => {}); }

  async request(user: string, onText: ((d: string) => void) | undefined, timeoutMs: number, annotations?: readonly DrawingAnnotation[], turn = new HarnessTurn()): Promise<HarnessResult> {
    this.used = true;
    const warm = this.sessionId !== null;
    const start = this.start;
    const sid = await this.sessionP.catch((e: unknown) => {
      // The session to continue or fork isn't there (or the server refused): nothing was sent to it.
      if (start && start.kind !== "new" && !this.server.exited) throw new SessionUnavailableError(`couldn't ${start.kind} session ${start.ref.id}: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    });
    const files = new FilesTouched(this.spec.project);
    const slash = this.spec.model.indexOf("/");
    const allowed = opencodeTools(this.spec);
    if (annotations?.length) {
      try {
        // /provider is specified by the installed OpenCode SDK. Older SDKs expose modalities.input.
        const catalog = await withTimeout(this.server.api("/provider", this.dir, { method: "GET" }), Math.min(timeoutMs, 15_000), "OpenCode image capabilities", () => {}) as { all?: { id: string; models: Record<string, { capabilities?: { input?: { image?: boolean } }; modalities?: { input?: string[] } }> }[] };
        const m = catalog.all?.find(p => p.id === this.spec.model.slice(0, slash))?.models[this.spec.model.slice(slash + 1)];
        assertDrawingVision(m?.capabilities?.input?.image ?? m?.modalities?.input?.includes("image"), "OpenCode", this.spec.model);
      } catch (err) {
        this.failed = true;
        void this.server.api(`/session/${sid}`, this.dir, { method: "DELETE" }).catch(() => {});
        throw err;
      }
    }
    await this.server.watch(this.dir);
    const needsNativeIdle = on(this.spec, "shell");
    await this.server.prepare(turn, needsNativeIdle);
    const messageId = opencodeMessageId();
    const ownMessages = new Set<string>();
    let sawRequest = false;
    let sawIdle = false;
    let responseFinished = false;
    let settle!: () => void;
    let rejectOnExit!: (error: Error) => void;
    const terminal = new Promise<void>((resolve) => { settle = resolve; });
    const exited = new Promise<never>((_, reject) => { rejectOnExit = reject; });
    const partType = new Map<string, string>();
    const held = new Map<string, string[]>();
    const unverifiedParts = new Map<string, Exclude<ReturnType<typeof opencodeEditEvent>, undefined>[]>();
    let streamed = "";
    const emit = (d: string): void => { streamed += d; if (!turn.stopping) onText?.(d); };
    const acceptMessage = (id: unknown, parentId: unknown) => {
      if (id === messageId) sawRequest = true;
      if (typeof id !== "string" || parentId !== messageId) return;
      sawRequest = true;
      ownMessages.add(id);
      for (const batch of unverifiedParts.get(id) ?? []) turn.edits(batch);
      unverifiedParts.delete(id);
    };
    this.server.listen(sid, (type, props) => {
      if (type === "server/exited") {
        turn.stop("interrupted");
        if (!needsNativeIdle || sawIdle) settle();
        else turn.uncertain("OpenCode may have left a detached shell running without confirming it stopped");
        rejectOnExit(new Error(String(props.message)));
      } else if (type === "session.idle" && sawRequest) {
        sawIdle = true;
        if (turn.stopping || responseFinished) settle();
      } else if (type === "message.updated") {
        const info = props.info as { id?: unknown; parentID?: unknown } | undefined;
        acceptMessage(info?.id, info?.parentID);
      } else if (type === "message.part.updated") {
        const part = props.part as { id?: string; type?: string; messageID?: string } | undefined;
        for (const f of opencodeEditedFiles(part)) files.add(f);
        const batch = turn.reportsEdits && opencodeEditEvent({ type, properties: props });
        if (batch && part?.messageID && batch.sessionId === sid) {
          if (ownMessages.has(part.messageID)) turn.edits(batch);
          else {
            const buffered = unverifiedParts.get(part.messageID) ?? [];
            if (unverifiedParts.size < 32 && buffered.length < 32) {
              buffered.push(batch);
              unverifiedParts.set(part.messageID, buffered);
            }
          }
        }
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
    }, this.dir, async () => {
      turn.stop("interrupted");
      if (sawIdle) settle();
      else this.abort();
      await terminal;
    });
    turn.holdUntil(terminal.then(() => {
      this.server.listen(sid, null);
      if (!this.kept) void this.server.api(`/session/${sid}`, this.dir, { method: "DELETE" }).catch(() => {});
    }));
    const response = this.server.api(`/session/${sid}/message`, this.dir, {
      method: "POST",
      body: {
        messageID: messageId,
        ...(slash > 0 ? { model: { providerID: this.spec.model.slice(0, slash), modelID: this.spec.model.slice(slash + 1) } } : {}),
        ...(this.spec.level ? { variant: this.spec.level } : {}),
        system: this.spec.system,
        // OpenCode converts this map to session permissions. The wildcard also denies unknown and MCP tools.
        ...(this.spec.commitMessage ? { agent: OPENCODE_COMMIT_AGENT, tools: { "*": false } }
          : { tools: Object.fromEntries(OPENCODE_TOOLS.map((t) => [t, allowed.includes(t)])) }),
        parts: opencodeParts(user, annotations),
      },
    }).then((result) => {
      const native = result as { info?: { id?: unknown; parentID?: unknown }; parts?: unknown[] };
      acceptMessage(native.info?.id, native.info?.parentID);
      if (turn.reportsEdits && typeof native.info?.id === "string" && ownMessages.has(native.info.id)) {
        for (const part of native.parts ?? []) {
          const batch = opencodeEditEvent(part);
          if (batch?.sessionId === sid) turn.edits(batch);
        }
      }
      responseFinished = true;
      if (sawIdle || (!turn.stopping && !turn.reportsEdits)) settle();
      return result;
    }, (error) => {
      if (error instanceof OpencodeResponseError && error.status >= 400 && error.status < 500 && !sawRequest) settle();
      else if (!turn.stopping) { turn.stop("failed"); this.abort(); }
      throw error;
    });
    const res = await withTimeout(Promise.race([response, exited]), timeoutMs, `opencode (${this.spec.role})`, () => {
      turn.stop("timed-out");
      if (sawIdle) settle();
      else this.abort();
    });
    if (!turn.stopping && responseFinished && !sawIdle) {
      // Successful HTTP completion proves the solver stopped. The idle event drains the SSE stream.
      // If a disconnected stream never confirms it, keep the tracked writer blocked for restart.
      if (turn.reportsEdits) turn.expectConfirmation();
    }
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
  }

  // A session's agent leaves its session saved (`opencode -s <id>`); a pooled one that was never used is removed.
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    if (this.kept) this.abort();
    else if (this.sessionId && !this.used) void this.server.api(`/session/${this.sessionId}`, this.dir, { method: "DELETE" }).catch(() => {});
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export const AGENT_FACTORIES: Record<HarnessId, AgentFactory> = {
  "claude-code": (s, start) => new ClaudeAgent(s, start),
  codex: (s, start) => new CodexAgent(s, start),
  // Cold only: each request is a new process; a session's agent runs them all on one saved Grok session.
  grok: (s, start) => new GrokAgent(s, start),
  opencode: (s, start) => new OpencodeAgent(s, start),
  pi: (s, start) => new RpcAgent(s, start),
  omp: (s, start) => new RpcAgent(s, start),
};

/**
 * Harnesses whose pooled (warm) agents can become a new session's agent (`keep()`); codex needs a non-ephemeral
 * thread, and grok has nothing to keep warm.
 */
export const KEEPS_POOLED: ReadonlySet<HarnessId> = new Set<HarnessId>(["claude-code", "opencode", "pi", "omp"]);

/** Stop the shared Codex / opencode servers when no pool or request uses them any more. */
export function stopSharedServers(inUse: Set<HarnessId>): void {
  if (!inUse.has("codex")) void CodexServer.stop();
  if (!inUse.has("opencode")) void OpencodeServer.stop();
}

/** Restart one shared harness and wait for its processes to stop writing. */
export function restartSharedHarness(harness: "codex" | "opencode"): Promise<void> {
  return harness === "codex" ? CodexServer.stop(true) : OpencodeServer.stop(true);
}

/** The variables `env` sets on top of the server's own (prompt inspector). */
const envOf = (env: NodeJS.ProcessEnv): string[] => Object.entries(env).filter(([k, v]) => process.env[k] !== v).map(([k, v]) => `${k}=${v}`);
const elide = (args: string[]): string[] => args.map((a) => (a.length > 60 ? "…" : /\s/.test(a) ? JSON.stringify(a) : a));

/** How an agent runs, for the prompt inspector. */
export function describeAgent(spec: AgentSpec): string {
  switch (spec.harness) {
    case "claude-code": return [...envOf(claudeEnv(spec)), "claude", ...elide(claudeArgs(spec, claudePlugins, spec.persist ? { start: { kind: "new" }, id: "<session id>" } : undefined))].join(" ");
    case "grok": return [...envOf(grokEnv(spec)), "grok", ...elide(grokArgs(spec, "…"))].join(" ");
    case "pi": case "omp": return [spec.harness, ...elide(rpcArgs(spec))].join(" ");
    case "codex":
      return `codex app-server · thread/start { model: ${spec.model || "default"}${spec.speed === "fast" ? ", serviceTier: priority" : ""}, sandbox: danger-full-access, approvalPolicy: never, ${spec.project ? "developerInstructions" : "baseInstructions"}, config: ${JSON.stringify(codexConfig(spec, ["…"]))} } → turn/start { effort: ${spec.level ?? "default"} } · on: ${onLabels(spec)}`;
    case "opencode": {
      const setup = opencodeSetup(spec);
      const env = Object.keys(setup.env).map((k) => `${k}=true `).join("");
      return `${env}opencode serve${setup.pure ? " --pure" : ""} · POST /session/:id/message { model: ${spec.model || "default"}, variant: ${spec.level ?? "default"}, system, tools: ${opencodeTools(spec).join(",") || "none"} } · permissions: ${spec.commitMessage ? "deny all" : "allow all"}`;
    }
  }
}
