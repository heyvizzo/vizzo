import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HarnessTurn } from "../adapters/harnesses.ts";
import { NativeHarnessProcess } from "../adapters/nativeProcess.ts";
import { LedgerLeaseRefusedError } from "./ledgerLease.ts";
import { LedgerWorkerClient } from "./ledgerWorkerClient.ts";
import { WriterRegistry, type WriterDispatch } from "./writers.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let fixture: string;
let root: string;
let journal: string;
let client: LedgerWorkerClient;
let registry: WriterRegistry;

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), "vizzo-writer-")));
  root = join(fixture, "project");
  journal = join(fixture, "config", "ledger.json");
  mkdirSync(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  client = new LedgerWorkerClient(journal);
  registry = new WriterRegistry(client);
});

afterEach(async () => {
  try { await client.close(); }
  finally { rmSync(fixture, { recursive: true, force: true }); }
});

async function project(directory = root) {
  const result = await client.discover(directory);
  if (!result.project) throw new Error(result.reason);
  return result.project;
}

function writer(overrides: Partial<WriterDispatch> = {}): WriterDispatch {
  return {
    writer: { kind: "thread", id: "thread" },
    title: "The footer", request: "Update the links", folder: root, purpose: "request", harness: "codex",
    ...overrides,
  };
}

describe("source-control writer registry", () => {
  it("hands off a foreground execution and its pending edit without creating a second execution", async () => {
    const { id } = await project();
    const done = deferred<string>();
    const started = deferred<void>();
    const execution = registry.queue(writer({ writer: { kind: "central", id: "turn" } }));
    const run = execution.run(() => { started.resolve(); return done.promise; });
    await started.promise;
    execution.edits("native-session", "native-tool", [{ path: join(root, "f"), from: "unseen", to: "changed" }]);
    execution.handoff("job", "Update the links");
    expect((await registry.snapshot(id)).executions).toEqual([
      expect.objectContaining({ executionId: execution.id, writer: { kind: "job", id: "job" }, phase: "running", pending: true }),
    ]);
    done.resolve("done");
    expect(await run).toBe("done");
    await expect.poll(async () => (await registry.snapshot(id)).executions[0]?.phase).toBe("settled");
    expect((await registry.snapshot(id)).executions[0]).toMatchObject({ outcome: "completed", pending: true });
  });

  it("keeps queued follow-ups and reconcile reservations visible until their dispatch", async () => {
    const { id } = await project();
    const spec = writer();
    const release = registry.reserve(id, [spec.writer]);
    const next = registry.queue({ ...spec, purpose: "followup" });
    const check = registry.queue({ ...spec, purpose: "reconcile" });
    let calls = 0;
    const run = next.run(async () => { calls++; });
    expect((await registry.snapshot(id)).executions).toEqual(expect.arrayContaining([
      expect.objectContaining({ executionId: next.id, phase: "queued", purpose: "followup" }),
      expect.objectContaining({ executionId: check.id, phase: "queued", purpose: "reconcile" }),
    ]));
    expect(calls).toBe(0);
    check.cancelQueued();
    release();
    await run;
    expect(calls).toBe(1);
    await expect.poll(async () => (await registry.snapshot(id)).executions.find((record) =>
      record.executionId === check.id)?.outcome).toBe("stopped");
  });

  it("keeps an uncertain stop blocked, then drains late edit evidence before settling", async () => {
    const p = await project();
    const execution = registry.queue(writer());
    const barrier = deferred<void>();
    const response = deferred<void>();
    const entered = deferred<void>();
    const run = execution.run(() => {
      execution.waitForSettlement(barrier.promise);
      entered.resolve();
      return response.promise;
    });
    await entered.promise;
    execution.stopping("timed-out");
    execution.unconfirmed();
    response.resolve();
    await run;
    expect((await registry.snapshot(p.id)).executions[0]).toMatchObject({ phase: "unconfirmed", outcome: "timed-out" });
    writeFileSync(join(root, "new"), "written after stop");
    execution.edits("s", "tool", [{ path: join(root, "new"), from: null, to: "written after stop" }]);
    barrier.resolve();
    await expect.poll(async () => (await registry.snapshot(p.id)).executions[0]?.phase).toBe("settled");
    expect((await client.observe(p, ["new"])).files[0]?.hunks[0]?.ownership.owners).toEqual([execution.id]);
  });

  it("restores pinned writer scope and interrupts an execution that was still running", async () => {
    const scope = join(root, "first");
    const other = join(root, "second");
    mkdirSync(scope);
    mkdirSync(other);
    const p = await project(scope);
    expect((await project(other)).id).toBe(p.id);
    const execution = registry.queue(writer({ folder: scope }));
    const never = deferred<void>();
    const entered = deferred<void>();
    void execution.run(() => { entered.resolve(); return never.promise; });
    await entered.promise;
    await client.close();
    client = new LedgerWorkerClient(journal);
    registry = new WriterRegistry(client);
    await registry.restore();
    expect((await registry.snapshot(p.id)).executions[0]).toMatchObject({
      executionId: execution.id, folder: scope, projectId: p.id, phase: "settled", outcome: "interrupted",
    });
  });
});

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")("native dispatch with an unavailable writer ledger", () => {
  it("keeps solver dispatch available when the lease was refused before any registration", async () => {
    const refused = new LedgerLeaseRefusedError("Another Vizzo process owns the source-control ledger");
    vi.spyOn(client, "restoreWriters").mockRejectedValue(refused);
    const save = vi.spyOn(client, "saveWriter");
    const discover = vi.spyOn(client, "discover");
    await expect(registry.restore()).rejects.toBe(refused);
    const execution = registry.queue(writer());
    const marker = join(root, "dispatched");
    await expect(execution.run(async () => {
      const turn = new HarnessTurn(execution);
      const native = new NativeHarnessProcess("/bin/sh", ["-c", "touch dispatched"], root, undefined, true);
      try {
        await turn.prepare(native);
        turn.holdUntil(native.closed);
        native.start();
        return await native.closed;
      } finally {
        await native.stop(true);
      }
    })).resolves.toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(discover).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    await expect(registry.snapshot("project")).rejects.toBe(refused);
  });

  it("blocks native dispatch if recording a process identity fails after writer registration", async () => {
    const saveWriter = client.saveWriter.bind(client);
    const failure = new LedgerLeaseRefusedError("Cannot record the native process");
    const save = vi.spyOn(client, "saveWriter").mockImplementation((project, execution) =>
      execution.nativeProcess ? Promise.reject(failure) : saveWriter(project, execution));
    const execution = registry.queue(writer());
    await expect(execution.run(async () => {
      const turn = new HarnessTurn(execution);
      const native = new NativeHarnessProcess("/bin/sh", ["-c", "touch dispatched"], root, undefined, true);
      try {
        await turn.prepare(native);
        native.start();
      } finally {
        await native.stop(true);
        await native.closed;
      }
    })).rejects.toBe(failure);
    expect(save).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ phase: "running", nativeDispatched: false }));
    expect(save).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ phase: "running", nativeDispatched: true }));
    expect(existsSync(join(root, "dispatched"))).toBe(false);
  });
});
