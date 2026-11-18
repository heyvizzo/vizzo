import type { ImageBlockParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { HarnessTurn } from "./harnesses.ts";
// The stream-json reader for `claude -p` (Claude Code, headless) and Grok's CLI, which prints the same events
// (--output-format streaming-messages-json). A `claude -p` agent starts with its system prompt, model and
// effort and waits for one user message on stdin (--input-format stream-json), so it can be spawned ahead
// of time (warmPool.ts keeps them warm); a request sends the message, streams the partial-message events
// back until the `result` event, and the process exits. One request per process = a fresh context, except for
// element-thread agents (`keep`): the process stays open and the next request is the next user message.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type CliRole = "router" | "fillers" | "solver";

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
  /** Every event as received. */
  onEvent?: (ev: Record<string, unknown>) => void;
  turn?: HarnessTurn;
}

/**
 * `claude -p` flags every agent gets: stream-json both ways. What it loads is up to its toggles, and whether its
 * conversation is saved (so it can be resumed) to its spec (claudeArgs).
 */
export const CLAUDE_BASE_ARGS = [
  "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
];

/** After an interrupt (stop, time limit), how long a kept agent has to end its turn before the process is killed. */
const INTERRUPT_GRACE_MS = 30_000;

/** Where agents run by default: an empty directory, so no project settings or CLAUDE.md are picked up. */
export const EMPTY_CWD = join(tmpdir(), "vizzo-agents");

export class CliAgent {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly spawnedAt = performance.now();
  private buf = "";
  private listeners = new Set<(ev: Record<string, unknown>) => void>();
  private stderr = "";
  exited = false;
  readonly exit: Promise<number | null>;
  /** The CLI's session id, from its events (every one carries it). */
  sessionId: string | undefined;
  /** The `system` / `init` event came: the conversation (new, resumed or forked) is attached. */
  attached = false;
  private controlSeq = 0;

  /** `role`: a label for errors ("router", "grok solver"…). */
  constructor(readonly role: string, readonly bin: string, args: string[], cwd: string = EMPTY_CWD, env: NodeJS.ProcessEnv = process.env) {
    mkdirSync(cwd, { recursive: true });
    this.proc = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env });
    this.proc.stdin.on("error", () => { /* Process close is the terminal signal. */ });
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
      if (typeof ev.session_id === "string" && ev.session_id) this.sessionId = ev.session_id;
      if (ev.type === "system" && ev.subtype === "init") this.attached = true;
      for (const l of this.listeners) l(ev);
    }
  }

  /**
   * Send one user message (`null`: the prompt was in the arguments) and stream the reply until the `result`
   * event. The process exits afterwards, unless `keep`: then it waits for the next message. A kept agent that runs
   * out of time is interrupted (it stays, with its conversation); it is only killed if it doesn't stop.
   */
  request(user: string | (ImageBlockParam | TextBlockParam)[] | null, handlers: CliHandlers, timeoutMs: number, warm: boolean, keep = false): Promise<CliResult> {
    handlers.turn?.checkBeforeSend();
    return new Promise<CliResult>((resolve, reject) => {
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => { settle = resolve; });
      const force = () => { if (!this.exited) this.proc.kill("SIGKILL"); };
      handlers.turn?.holdUntil(settled, force);
      let text = "";
      let stopReason: string | null = null;
      let assistant: unknown = null;
      const done = (fn: () => void, end = !keep) => {
        clearTimeout(timer);
        clearTimeout(grace);
        this.listeners.delete(listener);
        if (end) {
          try { this.proc.stdin.end(); } catch { /* already closed */ }
          setTimeout(() => { if (!this.exited) this.proc.kill("SIGTERM"); }, keep ? 0 : 2000).unref();
        }
        fn();
        settle();
      };
      const timedOut = (): Error => Object.assign(
        new Error(`${this.bin} (${this.role}) timed out after ${timeoutMs} ms`), { name: "TimeoutError" },
      );
      let overtime = false;
      let grace: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        overtime = true;
        handlers.turn?.stop("timed-out");
        if (user === null) this.kill(); else this.interrupt();
        reject(timedOut());
        if (!handlers.turn) grace = setTimeout(force, INTERRUPT_GRACE_MS).unref();
      }, timeoutMs);
      const listener = (ev: Record<string, unknown>): void => {
        handlers.onEvent?.(ev);
        if (ev.type === "stream_event") {
          const e = ev.event as { type?: string; delta?: { type?: string; text?: string; stop_reason?: string } } | undefined;
          if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) {
            text += e.delta.text;
            if (!overtime && !handlers.turn?.stopping) handlers.onText?.(e.delta.text);
          } else if (e?.type === "message_delta" && e.delta?.stop_reason) {
            stopReason = e.delta.stop_reason;
          }
        } else if (ev.type === "assistant") {
          assistant = ev.message ?? ev;
        } else if (ev.type === "result") {
          const r = ev as { subtype?: string; is_error?: boolean; result?: string; usage?: unknown; total_cost_usd?: number; duration_ms?: number; duration_api_ms?: number; modelUsage?: Record<string, unknown> };
          clearTimeout(grace);
          if (overtime) { done(() => reject(timedOut())); return; }
          if (r.is_error || (r.subtype && r.subtype !== "success")) {
            done(() => reject(new Error(`${this.bin} (${this.role}) failed: ${r.subtype ?? "error"}: ${String(r.result ?? "").slice(0, 300)}`)));
            return;
          }
          const model = (assistant as { model?: string } | null)?.model ?? Object.keys(r.modelUsage ?? {})[0];
          done(() => resolve({
            text: text || (typeof r.result === "string" ? r.result : ""), stopReason, usage: r.usage,
            cliCostUsd: r.total_cost_usd, durationMs: r.duration_ms, durationApiMs: r.duration_api_ms, model,
            raw: { result: ev, assistant }, warm,
          }));
        }
      };
      this.listeners.add(listener);
      this.exit.then((code) => {
        // `exitedEarly`: the process went before a result (a session that couldn't be resumed ends this way).
        if (this.listeners.has(listener)) done(() => reject(Object.assign(new Error(`${this.bin} (${this.role}) exited (${code}) before answering: ${this.stderr.trim().slice(-300)}`), { exitedEarly: true })));
      });
      if (user === null) this.proc.stdin.end();
      else this.proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: user } }) + "\n");
    });
  }

  /**
   * Stop the turn in flight (Claude Code's control request, as its SDK sends it): the turn ends with an error
   * `result`, the process and its conversation stay. Checked live on claude 2.1.322 (docs/API-NOTES.md).
   */
  interrupt(): void {
    if (this.exited) return;
    try {
      this.proc.stdin.write(JSON.stringify({ type: "control_request", request_id: `interrupt-${++this.controlSeq}`, request: { subtype: "interrupt" } }) + "\n");
    } catch { /* stdin closed: the process is going */ }
  }

  kill(): void {
    if (!this.exited) this.proc.kill("SIGTERM");
  }
}

/**
 * Run a CLI that prints `claude -p`'s stream-json events with the prompt in `args` (Grok's -p), spawned for
 * this one request.
 */
export function runStreamJson(label: string, bin: string, args: string[], cwd: string | undefined, handlers: CliHandlers, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<CliResult> {
  return new CliAgent(label, bin, args, cwd, env).request(null, handlers, timeoutMs, false);
}
