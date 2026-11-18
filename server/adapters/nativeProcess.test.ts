import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LedgerWorkerClient } from "../changes/ledgerWorkerClient.ts";
import { WriterRegistry } from "../changes/writers.ts";
import { NativeHarnessProcess, stopVerifiedNativeProcess, type NativeProcessIdentity } from "./nativeProcess.ts";

let folder: string;
let project: string;
let journal: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "vizzo-native-test-"));
  project = join(folder, "project");
  mkdirSync(project);
  journal = join(folder, "config", "ledger.json");
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

const nap = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hasActiveGroup(group: number): boolean {
  try { process.kill(-group, 0); return true; } catch { return false; }
}

function recordedIdentity(): NativeProcessIdentity {
  const saved = JSON.parse(readFileSync(journal, "utf8"));
  const records = Object.values(saved.projects)[0] as { writerRecords: Record<string, { nativeProcess: NativeProcessIdentity }> };
  return Object.values(records.writerRecords)[0]!.nativeProcess;
}

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")("verified native harness process groups", () => {
  it("kills the previous voice process's Bash descendants during genuine startup recovery", async () => {
    execFileSync("git", ["init", "-q", "-b", "main", project]);
    const recoverScript = join(folder, "voice.mts");
    const url = (relative: string) => new URL(relative, import.meta.url).href;
    writeFileSync(recoverScript, `
      import { NativeHarnessProcess } from ${JSON.stringify(url("./nativeProcess.ts"))};
      import { LedgerWorkerClient } from ${JSON.stringify(url("../changes/ledgerWorkerClient.ts"))};
      import { WriterRegistry } from ${JSON.stringify(url("../changes/writers.ts"))};
      const [project, journal] = process.argv.slice(2);
      const worker = new LedgerWorkerClient(journal);
      const registry = new WriterRegistry(worker);
      const execution = registry.queue({ writer: { kind: "job", id: "job" }, title: "Test", request: "Test", folder: project, purpose: "request", harness: "opencode" });
      await execution.run(async () => {
        const native = new NativeHarnessProcess("/bin/sh", ["-c", "echo started > started; sleep 4; echo delayed > delayed"], project, process.env, true);
        await native.prepare((identity) => execution.bindNative(identity));
        native.start();
        await native.closed;
      });
    `);
    const voice = spawn(process.execPath, ["--import", "tsx", recoverScript, project, journal], { stdio: "ignore" });
    const exit = once(voice, "exit");
    let identity: NativeProcessIdentity | undefined;
    const replacement = new LedgerWorkerClient(journal);
    try {
      await expect.poll(() => existsSync(join(project, "started")), { timeout: 5_000 }).toBe(true);
      identity = recordedIdentity();
      expect(hasActiveGroup(identity.group)).toBe(true);
      voice.kill("SIGKILL");
      expect(await exit).toEqual([null, "SIGKILL"]);
      expect(hasActiveGroup(identity.group)).toBe(true);
      expect(existsSync(join(project, "delayed"))).toBe(false);
      const { project: repo } = await replacement.discover(project);
      const registry = new WriterRegistry(replacement);
      await registry.restore();
      const { executions } = await registry.snapshot(repo!.id);
      expect(executions[0]).toMatchObject({ phase: "settled", outcome: "interrupted" });
      expect(executions[0]).not.toHaveProperty("nativeProcess");
      await nap(4000);
      expect(existsSync(join(project, "delayed"))).toBe(false);
    } finally {
      if (voice.exitCode === null && voice.signalCode === null) { voice.kill("SIGKILL"); await exit; }
      if (identity) await stopVerifiedNativeProcess(identity, true);
      await replacement.close();
    }
  }, 20_000);

  it("keeps waiting after the native leader exits until a resistant descendant stops", async () => {
    const script = "sh -c 'trap \"\" TERM; echo launched > child; sleep 2; echo delayed > delayed' & " +
      "while [ ! -f child ]; do sleep 0.01; done; echo exited > leader; exit 0";
    const process = new NativeHarnessProcess("/bin/sh", ["-c", script], project, undefined, true);
    try {
      await process.prepare();
      process.start();
      let settled = false;
      const barrier = process.closed.then(() => { settled = true; });
      await expect.poll(() => existsSync(join(project, "leader"))).toBe(true);
      expect(settled).toBe(false);
      await barrier;
      await nap(1200);
      expect(existsSync(join(project, "delayed"))).toBe(false);
    } finally { await process.stop(true); }
  }, 10_000);

  it("blocks recovery if a live group does not authenticate its saved instance", async () => {
    execFileSync("git", ["init", "-q", "-b", "main", project]);
    const native = new NativeHarnessProcess("/bin/sh", ["-c", "sleep 20"], project);
    const client = new LedgerWorkerClient(journal);
    let replacement: LedgerWorkerClient | undefined;
    try {
      await native.prepare();
      const registry = new WriterRegistry(client);
      const { project: repo } = await client.discover(project);
      const execution = registry.queue({ writer: { kind: "thread", id: "thread" }, title: "Test", request: "Test", folder: project, purpose: "request" });
      const wrong = { ...native.identity, token: "0".repeat(64) };
      await execution.bindNative(wrong);
      expect(await stopVerifiedNativeProcess(wrong, true)).toBe(false);
      await client.close();

      replacement = new LedgerWorkerClient(journal);
      const recovered = new WriterRegistry(replacement);
      await recovered.restore();
      expect((await recovered.snapshot(repo!.id)).executions[0]).toMatchObject({
        phase: "unconfirmed", outcome: "interrupted",
        reason: "Vizzo could not verify that the previous harness and its tools stopped",
      });
      expect(hasActiveGroup(native.identity.group)).toBe(true);
      expect(await native.stop(true)).toBe(true);
    } finally {
      await native.stop(true);
      if (replacement) await replacement.close();
      else await client.close().catch(() => {});
    }
  }, 20_000);
  it("stops the verified OpenCode group but blocks a shell-capable writer without native confirmation on restart", async () => {
    execFileSync("git", ["init", "-q", "-b", "main", project]);
    const native = new NativeHarnessProcess("/bin/sh", ["-c", "sleep 20"], project);
    const client = new LedgerWorkerClient(journal);
    let replacement: LedgerWorkerClient | undefined;
    try {
      await native.prepare();
      const registry = new WriterRegistry(client);
      const { project: repo } = await client.discover(project);
      const execution = registry.queue({
        writer: { kind: "thread", id: "thread" }, title: "Test", request: "Test", folder: project, purpose: "request", harness: "opencode",
      });
      await execution.bindNative(native.identity, true);
      await client.close();
      replacement = new LedgerWorkerClient(journal);
      const recovered = new WriterRegistry(replacement);
      await recovered.restore();
      await native.closed;
      expect((await recovered.snapshot(repo!.id)).executions[0]).toMatchObject({
        phase: "unconfirmed", outcome: "interrupted",
        reason: "OpenCode may have left a detached shell running without confirming it stopped",
      });
    } finally {
      await native.stop(true);
      if (replacement) await replacement.close();
      else await client.close().catch(() => {});
    }
  }, 20_000);
});
