import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessId } from "../../shared/config.ts";
import type { WriterExecution } from "../changes/writers.ts";
import { restartSharedHarness, STOP_CONFIRM_MS } from "./harnesses.ts";
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

function start(harness: HarnessId, mode: "late" | "never", taskTimeout = 60_000, gate?: () => Promise<void>) {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "vizzo-settle-")));
  vi.stubEnv(envBin[harness], fixture);
  vi.stubEnv("VIZZO_FAKE_NATIVE_HARNESS", harness);
  vi.stubEnv("VIZZO_FAKE_STOP_MODE", mode);
  vi.stubEnv("VIZZO_FAKE_PROJECT", folder);
  const observed = { folder, edits: vi.fn(), stopping: vi.fn(), unconfirmed: vi.fn(), waitForSettlement: vi.fn(), bindNative: vi.fn(gate ?? (async () => {})) };
  const active = deferred();
  const thread = openHarnessThread({ role: "solver", projectFolder: folder, choice: { provider: harness, model: "" }, replay: () => "" });
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
