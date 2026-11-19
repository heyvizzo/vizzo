import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessId } from "../../shared/config.ts";
import { LedgerWorkerClient } from "../changes/ledgerWorkerClient.ts";
import { WriterRegistry, type WriterExecution } from "../changes/writers.ts";
import { AGENT_FACTORIES, HarnessTurn, restartSharedHarness, STOP_CONFIRM_MS } from "./harnesses.ts";
import { openHarnessThread } from "./harnessThread.ts";
import { stopWarm } from "./warmPool.ts";
import "./claude.ts"; // registers solver prompts

const fixture = fileURLToPath(new URL("./__fixtures__/fake-settlement.mjs", import.meta.url));
const envBin: Record<HarnessId, string> = {
  "claude-code": "CLAUDE_BIN", grok: "GROK_BIN", pi: "PI_BIN", omp: "OMP_BIN", codex: "CODEX_BIN", opencode: "OPENCODE_BIN",
};
const harnesses = Object.keys(envBin) as HarnessId[];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixtureThread(folder: string, harness: HarnessId, mode: "late" | "never" | "descendant" | "reject-prompt") {
  vi.stubEnv(envBin[harness], fixture);
  vi.stubEnv("VIZZO_FAKE_NATIVE_HARNESS", harness);
  vi.stubEnv("VIZZO_FAKE_STOP_MODE", mode);
  vi.stubEnv("VIZZO_FAKE_PROJECT", folder);
  return openHarnessThread({ role: "solver", projectFolder: folder, choice: { provider: harness, model: "" }, replay: () => "" });
}

function start(harness: HarnessId, mode: Parameters<typeof fixtureThread>[2], taskTimeout = 60_000, gate?: () => Promise<void>) {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "vizzo-settle-")));
  const observed = {
    folder, edits: vi.fn(), observeNativeSession: vi.fn(), stopping: vi.fn(), unconfirmed: vi.fn(),
    waitForSettlement: vi.fn(), bindNative: vi.fn(gate ?? (async () => {})),
  };
  const active = deferred();
  const thread = fixtureThread(folder, harness, mode);
  const answer = thread.send("work", () => active.resolve(), taskTimeout, undefined, undefined, observed as unknown as WriterExecution);
  answer.catch(() => {});
  return { folder, observed, thread, answer, active: active.promise, close: () => {
    thread.close();
    rmSync(folder, { recursive: true, force: true });
  } };
}

afterEach(() => {
  vi.useRealTimers();
  stopWarm();
  vi.unstubAllEnvs();
});

describe.each(harnesses)("%s native stop settlement", (harness) => {
  it("returns AbortError promptly and keeps accepting proved late edits until the native terminal", async () => {
    const request = start(harness, "late");
    try {
      await request.active;
      let confirmed = false;
      const settled = request.thread.settled!.then(() => { confirmed = true; });
      request.thread.abort();
      await expect(request.answer).rejects.toMatchObject({ name: "AbortError" });
      expect(confirmed).toBe(false);
      await settled;
      const nativeCall = {
        "claude-code": "native-tool", omp: "native-tool", codex: JSON.stringify(["native-turn", "native-tool"]),
        opencode: "part-native", grok: undefined, pi: undefined,
      }[harness];
      if (nativeCall) {
        expect(request.observed.edits).toHaveBeenCalledExactlyOnceWith("native-session", nativeCall, expect.any(Array));
      } else expect(request.observed.edits).not.toHaveBeenCalled();
      expect(request.observed.unconfirmed).not.toHaveBeenCalled();
    } finally { request.close(); }
  }, 20_000);

  it("escalates exclusive processes after the grace period and keeps unproved shared stops blocked", async () => {
    const request = start(harness, "never");
    try {
      await request.active;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let confirmed = false;
      const settled = request.thread.settled!.then(() => { confirmed = true; });
      request.thread.abort();
      await expect(request.answer).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(STOP_CONFIRM_MS - 1);
      expect(confirmed).toBe(false);
      expect(request.observed.unconfirmed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      vi.useRealTimers();
      if (harness === "codex" || harness === "opencode") {
        expect(request.observed.unconfirmed).toHaveBeenCalledOnce();
        expect(confirmed).toBe(false);
        await restartSharedHarness(harness);
        expect(request.observed.stopping).toHaveBeenCalledWith("interrupted");
        if (harness === "opencode") {
          expect(request.observed.unconfirmed).toHaveBeenCalledWith("OpenCode may have left a detached shell running without confirming it stopped");
          expect(confirmed).toBe(false);
          return;
        }
      }
      await settled;
      expect(confirmed).toBe(true);
    } finally { request.close(); }
  }, 20_000);
});

it.each(["claude-code", "omp", "pi", "grok"] as const)("keeps a stopped %s writer active after terminal while its child can still write", async (harness) => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "vizzo-settle-child-")));
  const folder = join(temp, "project");
  mkdirSync(folder);
  const path = join(folder, "created");
  const release = join(folder, "release-descendant");
  const worker = new LedgerWorkerClient(join(temp, "ledger.json"));
  const registry = new WriterRegistry(worker);
  const thread = fixtureThread(folder, harness, "descendant");
  try {
    execFileSync("git", ["init", "-q", "-b", "main", folder]);
    if (harness === "omp") {
      writeFileSync(path, "before");
      execFileSync("git", ["-C", folder, "add", "created"]);
      execFileSync("git", ["-C", folder, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "initial"]);
    }
    const { project } = await registry.project(folder);
    const execution = registry.queue({ writer: { kind: "thread", id: "thread" }, title: "Test", request: "work", folder, purpose: "request", harness });
    const edits = vi.spyOn(execution, "edits");
    const phase = async () => (await registry.snapshot(project!.id)).executions[0]?.phase;
    const active = deferred();
    const answer = execution.run(() => thread.send("work", active.resolve, 60_000, undefined, undefined, execution));
    void answer.catch(() => {});
    await active.promise;
    const pid = thread.pid?.();
    const settled = thread.settled!;
    thread.abort();
    await expect(answer).rejects.toMatchObject({ name: "AbortError" });
    await expect.poll(() => existsSync(join(folder, "terminal")), { timeout: 5000 }).toBe(true);
    if (harness === "claude-code" || harness === "omp") {
      await expect.poll(() => edits.mock.calls.length, { timeout: 5000 }).toBe(1);
    }
    expect(readFileSync(path, "utf8")).toBe("proved");
    expect(await phase()).toBe("settling");

    writeFileSync(release, "");
    await settled;
    await expect.poll(phase, { timeout: 5000 }).toBe("settled");
    expect(readFileSync(path, "utf8")).toBe("late");
    if (harness !== "grok") {
      expect(pid).toBeTypeOf("number");
      await expect(thread.send("continue", undefined, 5000)).resolves.toMatchObject({ text: "resumed", session: { mode: "live" } });
      expect(thread.pid?.()).toBe(pid);
    }
  } finally {
    writeFileSync(release, "");
    thread.close();
    await thread.settled;
    await registry.flush();
    await worker.close();
    rmSync(temp, { recursive: true, force: true });
  }
}, 20_000);

it("escalates a timed-out private group even after a terminal while a child can still write", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const request = start("omp", "descendant", 500);
  try {
    await request.active;
    let confirmed = false;
    void request.thread.settled!.then(() => { confirmed = true; });
    await vi.advanceTimersByTimeAsync(500);
    await expect(request.answer).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.waitFor(() => expect(existsSync(join(request.folder, "terminal"))).toBe(true));
    await vi.waitFor(() => expect(request.observed.edits).toHaveBeenCalledOnce());
    expect(request.observed.stopping).toHaveBeenCalledWith("timed-out");
    expect(confirmed).toBe(false);
    await vi.advanceTimersByTimeAsync(STOP_CONFIRM_MS);
    await vi.waitFor(() => expect(confirmed).toBe(true), { timeout: 5000 });
    writeFileSync(join(request.folder, "release-descendant"), "");
    expect(readFileSync(join(request.folder, "created"), "utf8")).toBe("proved");
    expect(request.thread.live).toBe(false);
    expect(request.observed.unconfirmed).not.toHaveBeenCalled();
  } finally { request.close(); }
}, 20_000);

it("waits for RPC agent_end when an interrupted prompt reports rejection first", async () => {
  const request = start("omp", "reject-prompt");
  try {
    await request.active;
    const settled = request.thread.settled!;
    request.thread.abort();
    await expect(request.answer).rejects.toMatchObject({ name: "AbortError" });
    await expect.poll(() => existsSync(join(request.folder, "rejected"))).toBe(true);
    await expect(Promise.race([settled.then(() => "settled"), delay(500, "pending")])).resolves.toBe("pending");
    writeFileSync(join(request.folder, "release-terminal"), "");
    await settled;
    expect(request.thread.live).toBe(true);
  } finally { request.close(); }
}, 20_000);

it("reports a Codex timeout before native confirmation and still handles the interrupted turn's tool result", async () => {
  const request = start("codex", "late", 300);
  try {
    await request.active;
    const settled = request.thread.settled!;
    await expect(request.answer).rejects.toMatchObject({ name: "TimeoutError" });
    expect(request.observed.stopping).toHaveBeenCalledWith("timed-out");
    await settled;
    expect(request.observed.edits).toHaveBeenCalledOnce();
  } finally { request.close(); }
}, 20_000);

it("journals the private OpenCode identity before the prompt POST can run", async () => {
  const disarm = deferred();
  const binding = deferred();
  const request = start("opencode", "late", 60_000, async () => {
    binding.resolve();
    await disarm.promise;
  });
  try {
    let posted = false;
    void request.active.then(() => { posted = true; });
    await binding.promise;
    expect(posted).toBe(false);
    expect(request.observed.bindNative).toHaveBeenCalledOnce();
    disarm.resolve();
    await request.active;
    request.thread.abort();
    await expect(request.answer).rejects.toMatchObject({ name: "AbortError" });
    await request.thread.settled;
  } finally { disarm.resolve(); request.close(); }
}, 20_000);

it.each([false, true])("cleans up a canceled OpenCode draft (prompt posted: %s)", async (posted) => {
  const folder = mkdtempSync(join(tmpdir(), "vizzo-cancel-opencode-draft-"));
  vi.stubEnv("OPENCODE_BIN", fixture);
  vi.stubEnv("VIZZO_FAKE_NATIVE_HARNESS", "opencode");
  vi.stubEnv("VIZZO_FAKE_STOP_MODE", "cancel-draft");
  vi.stubEnv("VIZZO_FAKE_PROJECT", folder);
  const agent = AGENT_FACTORIES.opencode({ role: "router", harness: "opencode", model: "", system: "", commitMessage: true });
  const turn = new HarnessTurn();
  const dispatched = () => existsSync(join(folder, "draft-dispatched"));
  try {
    const draft = agent.request("Draft a commit message", undefined, 15_000, undefined, turn);
    void draft.catch(() => {});
    if (posted) await expect.poll(dispatched, { timeout: 5_000 }).toBe(true);
    turn.stop();
    agent.abort?.();
    if (!posted) await expect(draft).rejects.toMatchObject({ name: "AbortError" });
    await expect.poll(() => existsSync(join(folder, "draft-session-deleted")), { timeout: 5_000 }).toBe(true);
    expect(dispatched()).toBe(posted);
  } finally {
    await restartSharedHarness("opencode");
    rmSync(folder, { recursive: true, force: true });
  }
}, 20_000);

it("asks the owned OpenCode server to stop its tool before forced teardown and uses native idle", async () => {
  const request = start("opencode", "late");
  try {
    await request.active;
    const settled = request.thread.settled!;
    await restartSharedHarness("opencode");
    await settled;
    expect(request.observed.stopping).toHaveBeenCalledWith("interrupted");
    expect(request.observed.unconfirmed).not.toHaveBeenCalled();
    expect(request.observed.edits).toHaveBeenCalledExactlyOnceWith("native-session", "part-native", expect.any(Array));
  } finally { request.close(); }
}, 20_000);
