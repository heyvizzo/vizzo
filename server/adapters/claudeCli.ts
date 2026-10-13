// Claude through pre-spawned `claude -p` agents (Claude Code CLI, headless). Each role (router, progress
// lines, Opus) keeps warm processes started with its system prompt, model and effort, waiting for input
// on stdin (--input-format stream-json); a request takes one, sends one user message, streams the
// partial-message events back, and the process exits. A replacement is spawned right away, so the CLI's
// boot time (~0.5–1 s) is paid ahead of time. One request per process = a fresh context every time.
// `startClaudeAgents()` (called by `npm run dev` / server start) spawns the pools; `stopClaudeAgents()`
// kills them (also on process exit).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CliRole = "router" | "fillers" | "opus";

export interface CliRoleSpec {
  model: string;
  effort: "low" | "medium" | "high";
  /** Full system prompt (fixed for the process). */
  system: () => string;
}

/** What one request returned. */
export interface CliResult {
  text: string;
  stopReason: string | null;
  usage: unknown;
  /** The CLI's own cost estimate (result.total_cost_usd). */
  cliCostUsd?: number;
  durationMs?: number;
  durationApiMs?: number;
  model?: string;
  /** The final `result` event and the final `assistant` message, as received. */
  raw: { result: unknown; assistant: unknown };
  /** Spawn → ready-for-input time had already elapsed (true) or the request had to wait for a cold start. */
  warm: boolean;
}

export interface CliHandlers {
  /** Text deltas of the assistant's reply (thinking deltas are skipped). */
  onText?: (delta: string) => void;
}

const BASE_ARGS = [
  "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
  // No tools, no hooks/plugins/CLAUDE.md, no MCP, nothing saved: a plain model call with our system prompt.
  "--tools", "", "--safe-mode", "--strict-mcp-config", "--no-session-persistence",
];

/** Where agents run: an empty directory, so no project settings or CLAUDE.md are picked up. */
const CWD = join(tmpdir(), "realtime-voice-claude-agents");

let log: (msg: string) => void = (msg) => console.info(msg);
export function setCliLogger(fn: (msg: string) => void): void { log = fn; }

class CliAgent {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly spawnedAt = performance.now();
  private buf = "";
  private listeners = new Set<(ev: Record<string, unknown>) => void>();
  private stderr = "";
  exited = false;
  readonly exit: Promise<number | null>;

  constructor(readonly role: CliRole, spec: CliRoleSpec, readonly bin: string) {
    mkdirSync(CWD, { recursive: true });
    this.proc = spawn(bin, [...BASE_ARGS, "--model", spec.model, "--effort", spec.effort, "--system-prompt", spec.system()], {
      cwd: CWD, stdio: ["pipe", "pipe", "pipe"], env: process.env,
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d: string) => this.onData(d));
    this.proc.stderr.on("data", (d: Buffer) => { this.stderr = (this.stderr + d.toString()).slice(-2000); });
    this.exit = new Promise((resolve) => this.proc.on("close", (code) => { this.exited = true; resolve(code); }));
    this.proc.on("error", (e) => { this.exited = true; this.stderr += String(e); });
  }

  private onData(d: string): void {
    this.buf += d;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(line); } catch { continue; }
      for (const l of this.listeners) l(ev);
    }
  }

  /** Send one user message and stream the reply until the `result` event. The process exits afterwards. */
  request(user: string, handlers: CliHandlers, timeoutMs: number, warm: boolean): Promise<CliResult> {
    return new Promise<CliResult>((resolve, reject) => {
      let text = "";
      let stopReason: string | null = null;
      let assistant: unknown = null;
      const done = (fn: () => void) => {
        clearTimeout(timer);
        this.listeners.clear();
        try { this.proc.stdin.end(); } catch { /* already closed */ }
        setTimeout(() => { if (!this.exited) this.proc.kill("SIGTERM"); }, 2000).unref();
        fn();
      };
      const timer = setTimeout(() => done(() => reject(new Error(`claude -p (${this.role}) timed out after ${timeoutMs} ms`))), timeoutMs);
      this.listeners.add((ev) => {
        if (ev.type === "stream_event") {
          const e = ev.event as { type?: string; delta?: { type?: string; text?: string; stop_reason?: string } } | undefined;
          if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) {
            text += e.delta.text;
            handlers.onText?.(e.delta.text);
          } else if (e?.type === "message_delta" && e.delta?.stop_reason) {
            stopReason = e.delta.stop_reason;
          }
        } else if (ev.type === "assistant") {
          assistant = ev.message ?? ev;
        } else if (ev.type === "result") {
          const r = ev as { subtype?: string; is_error?: boolean; result?: string; usage?: unknown; total_cost_usd?: number; duration_ms?: number; duration_api_ms?: number; modelUsage?: Record<string, unknown> };
          if (r.is_error || (r.subtype && r.subtype !== "success")) {
            done(() => reject(new Error(`claude -p (${this.role}) failed: ${r.subtype ?? "error"}: ${String(r.result ?? "").slice(0, 300)}`)));
            return;
          }
          const model = (assistant as { model?: string } | null)?.model ?? Object.keys(r.modelUsage ?? {})[0];
          done(() => resolve({
            text: text || (typeof r.result === "string" ? r.result : ""), stopReason, usage: r.usage,
            cliCostUsd: r.total_cost_usd, durationMs: r.duration_ms, durationApiMs: r.duration_api_ms, model,
            raw: { result: ev, assistant }, warm,
          }));
        }
      });
      this.exit.then((code) => {
        if (this.listeners.size) done(() => reject(new Error(`claude -p (${this.role}) exited (${code}) before answering: ${this.stderr.trim().slice(-300)}`)));
      });
      this.proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: user } }) + "\n");
    });
  }

  kill(): void {
    if (!this.exited) this.proc.kill("SIGTERM");
  }
}

class CliPool {
  private idle: CliAgent[] = [];
  private stopped = false;
  constructor(readonly role: CliRole, private spec: CliRoleSpec, private size: number, private bin: string) {}

  fill(): void {
    if (this.stopped) return;
    this.idle = this.idle.filter((a) => !a.exited);
    while (this.idle.length < this.size) {
      const a = new CliAgent(this.role, this.spec, this.bin);
      a.exit.then(() => { this.idle = this.idle.filter((x) => x !== a); });
      this.idle.push(a);
    }
  }

  /** A waiting agent (or a cold one if none), and a replacement starts in the background. */
  take(): { agent: CliAgent; warm: boolean } {
    const ready = this.idle.find((a) => !a.exited);
    if (ready) this.idle = this.idle.filter((a) => a !== ready);
    const agent = ready ?? new CliAgent(this.role, this.spec, this.bin);
    // Replace it right away so the next request finds a booted process.
    queueMicrotask(() => this.fill());
    return { agent, warm: !!ready && performance.now() - ready.spawnedAt > 800 };
  }

  get idleCount(): number { return this.idle.filter((a) => !a.exited).length; }

  stop(): void {
    this.stopped = true;
    for (const a of this.idle) a.kill();
    this.idle = [];
  }
}

const pools = new Map<CliRole, CliPool>();
let specsFn: (() => Record<CliRole, CliRoleSpec>) | null = null;
let exitHooked = false;

/** Default pool sizes; override with CLAUDE_AGENTS="router:2,fillers:1,opus:2". */
export function poolSizes(env = process.env.CLAUDE_AGENTS): Record<CliRole, number> {
  const sizes: Record<CliRole, number> = { router: 1, fillers: 1, opus: 1 };
  for (const part of (env ?? "").split(",")) {
    const [k, v] = part.split(":").map((s) => s.trim());
    if ((k === "router" || k === "fillers" || k === "opus") && v !== undefined && /^\d+$/.test(v)) sizes[k] = Number(v);
  }
  return sizes;
}

/** Register the role specs (prompts/models). Called by the Claude adapter at load. */
export function registerCliSpecs(fn: () => Record<CliRole, CliRoleSpec>): void { specsFn = fn; }

/** Spawn the agent pools (idempotent). `npm run dev` does this at server start. */
export function startClaudeAgents(opts: { bin?: string; sizes?: Partial<Record<CliRole, number>> } = {}): void {
  if (!specsFn) throw new Error("claude -p specs not registered");
  const specs = specsFn();
  const sizes = { ...poolSizes(), ...opts.sizes };
  for (const role of ["router", "fillers", "opus"] as const) {
    if (pools.has(role)) continue;
    const pool = new CliPool(role, specs[role], sizes[role], opts.bin ?? process.env.CLAUDE_BIN ?? "claude");
    pools.set(role, pool);
    pool.fill();
  }
  if (!exitHooked) {
    exitHooked = true;
    process.once("exit", stopClaudeAgents);
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { stopClaudeAgents(); process.exit(0); });
  }
  log(`[claude-cli] agents warming: ${(["router", "fillers", "opus"] as const).map((r) => `${r}×${sizes[r]} (${specs[r].model}, effort ${specs[r].effort})`).join(", ")}`);
}

export function stopClaudeAgents(): void {
  for (const p of pools.values()) p.stop();
  pools.clear();
}

export function agentStatus(): Record<string, number> {
  return Object.fromEntries([...pools].map(([r, p]) => [r, p.idleCount]));
}

const TIMEOUTS: Record<CliRole, number> = { router: 30_000, fillers: 20_000, opus: 180_000 };

/** One request on a fresh agent of `role` (starts the pools if they aren't running yet). */
export async function cliRequest(role: CliRole, user: string, handlers: CliHandlers = {}): Promise<CliResult> {
  if (!pools.has(role)) startClaudeAgents();
  const { agent, warm } = pools.get(role)!.take();
  return agent.request(user, handlers, TIMEOUTS[role], warm);
}

/** The spec a role runs with (for the prompt inspector). */
export function cliSpec(role: CliRole): CliRoleSpec {
  if (!specsFn) throw new Error("claude -p specs not registered");
  return specsFn()[role];
}

export const CLI_ARGS_SUMMARY = "claude -p --input-format stream-json --output-format stream-json --include-partial-messages --tools \"\" --safe-mode --strict-mcp-config --no-session-persistence";
