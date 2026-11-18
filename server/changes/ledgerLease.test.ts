import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LedgerPersistence } from "./persistence.ts";

const projectId = "f".repeat(64);
let fixture: string;
let directory: string;
let journal: string;
let voiceScript: string;
const voices = new Map<ChildProcess, Promise<unknown[]>>();

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), "vizzo-ledger-lease-test-"));
  directory = join(fixture, "config");
  journal = join(directory, "ledger.json");
  voiceScript = join(fixture, "voice.mts");
  writeFileSync(voiceScript, `
    import { parentPort, workerData } from "node:worker_threads";
    import { LedgerPersistence } from ${JSON.stringify(new URL("./persistence.ts", import.meta.url).href)};
    const [journal, initial] = workerData ?? process.argv.slice(2);
    const persistence = new LedgerPersistence(journal);
    persistence.acquireLease();
    persistence.save({ ["${projectId}"]: initial });
    process.on("message", (value) => {
      try {
        persistence.save({ ["${projectId}"]: value });
        process.send("saved");
      } catch (error) {
        process.send(error.message);
      }
    });
    if (parentPort) {
      parentPort.on("message", () => {});
      parentPort.postMessage("ready");
    } else process.send("ready");
  `);
});

afterEach(async () => {
  try {
    for (const [voice, exit] of voices) {
      if (voice.exitCode === null && voice.signalCode === null) voice.kill("SIGKILL");
      await exit;
    }
  } finally {
    voices.clear();
    rmSync(fixture, { recursive: true, force: true });
  }
});

async function startVoice(value: string): Promise<ChildProcess> {
  const voice = fork(voiceScript, [journal, value], { execArgv: ["--import", "tsx"] });
  const exit = once(voice, "exit");
  voices.set(voice, exit);
  const ready = once(voice, "message");
  expect((await Promise.race([ready, exit]))[0]).toBe("ready");
  return voice;
}

async function saveWith(voice: ChildProcess, value: string): Promise<unknown> {
  const reply = once(voice, "message");
  voice.send(value);
  return (await reply)[0];
}

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")("source-control ledger lease", () => {
  it("refuses a second voice at a canonical alias and releases the same inode after a crash", async () => {
    const owner = await startVoice("first");
    const leasePath = `${journal}.lock`;
    const lockInode = lstatSync(leasePath, { bigint: true }).ino;
    expect(lstatSync(leasePath).mode & 0o777).toBe(0o600);
    const alias = join(fixture, "alias");
    symlinkSync(directory, alias);
    const competitor = new LedgerPersistence(join(alias, "ledger.json"));
    const refused = expect.objectContaining({
      code: "LEDGER_LEASE_REFUSED", message: "Another Vizzo process owns the source-control ledger",
    });
    expect(() => competitor.acquireLease()).toThrow(refused);
    expect(() => competitor.save({ [projectId]: "foreign write" })).toThrow(refused);
    expect(() => competitor.load()).toThrow(refused);
    expect(await saveWith(owner, "still active")).toBe("saved");
    expect(JSON.parse(readFileSync(journal, "utf8")).projects[projectId]).toBe("still active");
    expect(owner.kill("SIGKILL")).toBe(true);
    expect(await voices.get(owner)).toEqual([null, "SIGKILL"]);
    await startVoice("recovered");
    expect(lstatSync(leasePath, { bigint: true }).ino).toBe(lockInode);
    expect(JSON.parse(readFileSync(journal, "utf8")).projects[projectId]).toBe("recovered");
  });

  it("refuses an existing symlink or hard link at the lock path and a symlink at the journal", () => {
    mkdirSync(directory);
    const target = join(fixture, "target");
    const lock = `${journal}.lock`;
    writeFileSync(target, "existing bytes", { mode: 0o600 });
    const refused = expect.objectContaining({ code: "LEDGER_LEASE_REFUSED" });
    symlinkSync(target, lock);
    expect(() => new LedgerPersistence(journal).acquireLease()).toThrow(refused);
    expect(lstatSync(lock).isSymbolicLink()).toBe(true);
    rmSync(lock);
    linkSync(target, lock);
    expect(() => new LedgerPersistence(journal).acquireLease()).toThrow(refused);
    expect(lstatSync(lock).nlink).toBe(2);
    rmSync(lock);
    symlinkSync(target, journal);
    expect(() => new LedgerPersistence(journal).acquireLease()).toThrow(refused);
    expect(lstatSync(journal).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("existing bytes");
  });

  it("releases the lock descriptor when an owning worker thread exits", async () => {
    const worker = new Worker(voiceScript, { execArgv: ["--import", "tsx"], workerData: [journal, "first"] });
    try {
      expect(await once(worker, "message")).toEqual(["ready"]);
      expect(() => new LedgerPersistence(journal).acquireLease()).toThrow("Another Vizzo process owns");
    } finally {
      await worker.terminate();
    }
    await startVoice("next");
    expect(JSON.parse(readFileSync(journal, "utf8")).projects[projectId]).toBe("next");
  });

  it("blocks later writes when the held lock file was replaced", async () => {
    const owner = await startVoice("first");
    const lock = `${journal}.lock`;
    renameSync(lock, join(directory, "displaced"));
    writeFileSync(lock, "", { mode: 0o600 });
    expect(await saveWith(owner, "late")).toBe("The source-control ledger lock was substituted or is no longer private");
    expect(JSON.parse(readFileSync(journal, "utf8")).projects[projectId]).toBe("first");
  });
});
