// Private process groups keep a harness and its tool descendants together. The group leader proves
// its instance identity through a private socket and signals its own group, so Vizzo never signals a recycled PID.
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";

export interface NativeProcessIdentity {
  group: number;
  socket: string;
  token: string;
}

const SOCKET = /^\/tmp\/vizzo-native-[A-Za-z0-9]{6}\/control$/;
const TOKEN = /^[a-f0-9]{64}$/;
const STOP_WAIT_MS = 6_000;
const PROVE_MS = 1_000;
const FORCE_AFTER_MS = 1_000;
const LOST_PARENT_MS = 8_000;
const supported = process.platform === "darwin" || process.platform === "linux";

function signature(token: string, action: "prove" | "stop" | "stop-orphan", nonce: string): Buffer {
  return createHmac("sha256", token).update(`${action}:${nonce}`).digest();
}

function sameSignature(expected: Buffer, actual: unknown): boolean {
  return typeof actual === "string" && TOKEN.test(actual) && timingSafeEqual(expected, Buffer.from(actual, "hex"));
}

function inspectGroup(group: number, keptPid?: number): Promise<boolean> {
  // A zombie cannot write. This also works in development containers whose PID 1 waits to reap a child.
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-axo", "pid=,pgid=,stat="], {
      timeout: PROVE_MS, maxBuffer: 512_000, env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
    }, (error, stdout) => {
      if (error || !stdout.trim()) { resolve(false); return; }
      let sawSupervisor = false;
      let sawKept = false;
      for (const line of stdout.trimEnd().split("\n")) {
        const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
        if (!row) { resolve(false); return; }
        if (Number(row[2]) !== group || row[3]!.startsWith("Z")) continue;
        const pid = Number(row[1]);
        if (keptPid !== undefined && pid === group) sawSupervisor = true;
        else if (pid === keptPid) sawKept = true;
        else { resolve(false); return; }
      }
      resolve(keptPid === undefined || (sawSupervisor && sawKept));
    });
  });
}

function validIdentity(identity: NativeProcessIdentity): boolean {
  return Number.isSafeInteger(identity.group) && identity.group > 1 && SOCKET.test(identity.socket) && TOKEN.test(identity.token);
}

function isGroupGone(group: number): Promise<boolean> {
  try { process.kill(-group, 0); }
  catch (error) { return Promise.resolve((error as NodeJS.ErrnoException).code === "ESRCH"); }
  return inspectGroup(group);
}

async function waitForGroup(group: number): Promise<boolean> {
  const start = performance.now();
  do {
    if (await isGroupGone(group)) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } while (performance.now() - start < STOP_WAIT_MS);
  return false;
}

function authorize(identity: NativeProcessIdentity, stop?: { force: boolean; orphanOnly: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const nonce = randomBytes(32).toString("hex");
    const peer = connect(identity.socket);
    let authenticated = false;
    let done = false;
    let buffer = "";
    const finish = (accepted: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      peer.destroy();
      resolve(accepted);
    };
    const timer = setTimeout(() => finish(false), PROVE_MS);
    peer.on("connect", () => peer.write(JSON.stringify({ nonce }) + "\n"));
    peer.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0 && !done) {
        let message: { group?: unknown; proof?: unknown; stopping?: unknown };
        try { message = JSON.parse(buffer.slice(0, end)); }
        catch { finish(false); return; }
        buffer = buffer.slice(end + 1);
        if (!authenticated) {
          if (message?.group !== identity.group || !sameSignature(signature(identity.token, "prove", nonce), message.proof)) {
            finish(false);
            return;
          }
          if (!stop) { finish(true); return; }
          authenticated = true;
          const action = stop.orphanOnly ? "stop-orphan" : "stop";
          peer.write(JSON.stringify({ stop: signature(identity.token, action, nonce).toString("hex"), ...stop }) + "\n");
        } else finish(message?.stopping === true);
      }
      if (buffer.length > 4096) finish(false);
    });
    peer.on("error", () => finish(false));
    peer.on("close", () => finish(false));
  });
}

function privateEndpoint(identity: NativeProcessIdentity): boolean {
  if (!supported || !validIdentity(identity)) return false;
  const directory = identity.socket.slice(0, -"/control".length);
  try {
    const path = lstatSync(directory);
    const socket = lstatSync(identity.socket);
    return path.isDirectory() && path.uid === process.getuid?.() && (path.mode & 0o077) === 0 &&
      socket.isSocket() && socket.uid === path.uid;
  } catch { return false; }
}

async function stopVerifiedGroup(identity: NativeProcessIdentity, force: boolean, orphanOnly: boolean): Promise<boolean> {
  if (!supported || !validIdentity(identity)) return false;
  if (await isGroupGone(identity.group)) return true;
  if (!privateEndpoint(identity) || !await authorize(identity, { force, orphanOnly })) return isGroupGone(identity.group);
  return waitForGroup(identity.group);
}

/** An unreachable or unauthenticated live group is unresolved and is never signaled. */
export function stopVerifiedNativeProcess(identity: NativeProcessIdentity, force = false): Promise<boolean> {
  return stopVerifiedGroup(identity, force, false);
}

/** Recovery can only signal after the supervisor loses its owning voice control connection. */
export function stopVerifiedOrphanNativeProcess(identity: NativeProcessIdentity): Promise<boolean> {
  return stopVerifiedGroup(identity, true, true);
}

// The supervisor runs under the same Node/Electron executable with no project code or modules loaded.
// FD 3 carries the Vizzo token and start gate. The native child's stdin/out/err are the original pipes.
const SUPERVISOR = String.raw`
const { spawn } = require("node:child_process");
const { createHmac, timingSafeEqual } = require("node:crypto");
const { createServer, Socket } = require("node:net");
const control = new Socket({ fd: 3, readable: true, writable: true });
control.on("error", () => {});
process.on("SIGTERM", () => {});
const send = (data) => { if (control.writable) control.write(JSON.stringify(data) + "\n"); };
let payload;
let terminal = false;
let ownerDisconnected = false;
let child;
let pending = "";
const terminate = (force) => {
  if (!terminal) {
    terminal = true;
    process.kill(-process.pid, force ? "SIGKILL" : "SIGTERM");
    setTimeout(() => process.kill(-process.pid, "SIGKILL"), ${FORCE_AFTER_MS});
  } else if (force) process.kill(-process.pid, "SIGKILL");
};
const launch = () => {
  if (child || terminal) return;
  const env = { ...process.env };
  if (payload.runAsNode === undefined) delete env.ELECTRON_RUN_AS_NODE;
  else env.ELECTRON_RUN_AS_NODE = payload.runAsNode;
  if (payload.nodeOptions !== undefined) env.NODE_OPTIONS = payload.nodeOptions;
  if (payload.nodePath !== undefined) env.NODE_PATH = payload.nodePath;
  child = spawn(payload.bin, payload.args, { cwd: payload.cwd, env, stdio: [0, 1, 2] });
  child.on("spawn", () => send({ type: "native", pid: child.pid }));
  child.on("error", (error) => send({ type: "error", code: error.code }));
  child.on("close", (code) => {
    send({ type: "exit", code });
    terminate(false);
  });
};
const setup = (configuration) => {
  payload = configuration;
  const mac = (action, nonce) => createHmac("sha256", payload.token).update(action + ":" + nonce).digest();
  const server = createServer((peer) => {
    let buffer = "";
    let nonce;
    peer.setTimeout(2000, () => peer.destroy());
    peer.on("error", () => {});
    peer.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 4096) { peer.destroy(); return; }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        let message;
        try { message = JSON.parse(buffer.slice(0, end)); }
        catch { peer.destroy(); return; }
        buffer = buffer.slice(end + 1);
        if (!nonce) {
          if (!/^[a-f0-9]{64}$/.test(message?.nonce)) { peer.destroy(); return; }
          nonce = message.nonce;
          peer.write(JSON.stringify({ group: process.pid, proof: mac("prove", nonce).toString("hex") }) + "\n");
        } else {
          const proof = message?.stop;
          const orphanOnly = message?.orphanOnly === true;
          if (typeof proof !== "string" || !/^[a-f0-9]{64}$/.test(proof) ||
              !timingSafeEqual(mac(orphanOnly ? "stop-orphan" : "stop", nonce), Buffer.from(proof, "hex"))) { peer.destroy(); return; }
          if (orphanOnly && !ownerDisconnected) { peer.end('{"stopping":false}\n'); return; }
          peer.end('{"stopping":true}\n', () => terminate(orphanOnly || message.force === true));
          return;
        }
      }
    });
  });
  server.on("error", () => { send({ type: "error", code: "SUPERVISOR_SOCKET" }); terminate(false); });
  server.listen(payload.socket, () => { send({ type: "ready" }); if (!payload.paused) launch(); });
};
control.on("close", () => {
  ownerDisconnected = true;
  setTimeout(() => terminate(true), ${LOST_PARENT_MS}).unref();
});
control.on("data", (chunk) => {
  pending += chunk.toString();
  let end;
  while ((end = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    const message = JSON.parse(line);
    if (!payload) setup(message);
    else if (message.start === true) launch();
    else if (message.interrupt === true && child?.exitCode === null && child?.signalCode === null) child.kill("SIGTERM");
  }
});
`;

export class NativeHarnessProcess {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly identity: NativeProcessIdentity;
  private readonly control: Duplex;
  private readonly ready: Promise<void>;
  private native: number | undefined;
  private exitCode: number | null = null;
  readonly closed: Promise<number | null>;

  constructor(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env, paused = false) {
    if (!supported) throw new Error("Verified harness process groups are unavailable on this platform");
    const directory = mkdtempSync("/tmp/vizzo-native-");
    chmodSync(directory, 0o700);
    const socket = join(directory, "control");
    const token = randomBytes(32).toString("hex");
    const launcherEnv: NodeJS.ProcessEnv = { ...env, ELECTRON_RUN_AS_NODE: "1" };
    delete launcherEnv.NODE_OPTIONS;
    delete launcherEnv.NODE_PATH;
    this.proc = spawn(process.execPath, ["-e", SUPERVISOR], {
      detached: true,
      cwd,
      env: launcherEnv,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.control = this.proc.stdio[3] as Duplex;
    this.identity = { group: this.proc.pid ?? 0, socket, token };
    let accept!: () => void;
    let refuse!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => { accept = resolve; refuse = reject; });
    const bootTimeout = setTimeout(() => {
      refuse(new Error("The harness process supervisor did not start"));
      this.control.end();
    }, STOP_WAIT_MS).unref();
    void this.ready.then(() => clearTimeout(bootTimeout), () => clearTimeout(bootTimeout));
    this.proc.on("error", (error) => refuse(error));
    this.control.on("error", (error) => refuse(error));
    let buffer = "";
    this.control.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end)) as { type: string; pid?: number; code?: number | string };
        buffer = buffer.slice(end + 1);
        if (message.type === "ready") accept();
        else if (message.type === "native") this.native = message.pid;
        else if (message.type === "exit") {
          this.native = undefined;
          this.exitCode = typeof message.code === "number" ? message.code : null;
        }
        else if (message.type === "error") refuse(new Error(`Could not start harness process (${message.code ?? "unknown error"})`));
      }
    });
    this.closed = new Promise<number | null>((resolve) => this.proc.on("close", (code) => {
      refuse(new Error("Harness process group exited before becoming ready"));
      const finish = async () => {
        if (validIdentity(this.identity) && !await waitForGroup(this.identity.group)) {
          setTimeout(() => { void finish(); }, 500).unref();
          return;
        }
        try { unlinkSync(socket); } catch { /* the supervisor may have exited before creating the socket */ }
        try { rmdirSync(directory); } catch { /* temporary directory cleanup is best effort */ }
        resolve(this.exitCode ?? code);
      };
      void finish();
    }));
    this.control.write(JSON.stringify({
      bin, args, cwd, socket, token, paused, runAsNode: env.ELECTRON_RUN_AS_NODE,
      nodeOptions: env.NODE_OPTIONS, nodePath: env.NODE_PATH,
    }) + "\n");
  }

  get nativePid(): number | undefined { return this.native; }

  async prepare(persist?: (identity: NativeProcessIdentity) => Promise<void>): Promise<void> {
    await this.ready;
    if (persist) await persist(this.identity);
  }

  async verify(): Promise<boolean> {
    await this.ready.catch(() => {});
    return privateEndpoint(this.identity) && authorize(this.identity);
  }

  /** After an interrupted turn's terminal, wait for its tools or the entire group to exit. */
  async waitForStoppedTurn(keep: boolean): Promise<void> {
    while (keep && this.proc.exitCode === null && this.proc.signalCode === null) {
      const pid = this.native;
      if (pid !== undefined) {
        const clear = await this.verify().then((verified) => verified && inspectGroup(this.identity.group, pid)).catch(() => false);
        if (clear && this.native === pid) return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100).unref());
    }
    await this.closed;
  }

  start(): void { this.control.write('{"start":true}\n'); }
  interrupt(): void { this.control.write('{"interrupt":true}\n'); }

  async stop(force = false): Promise<boolean> {
    // The supervisor can still be setting up its socket. If it cannot be verified, leave the group alone.
    await this.ready.catch(() => {});
    return stopVerifiedNativeProcess(this.identity, force);
  }
}
