// Installs and removes the on-device speech engines' models from Settings (Speech to text / Text to speech → Install,
// Uninstall), and downloads more Piper voices when one is picked. An install runs the engine's part of
// scripts/setup-local-{tts,stt}.sh (the same steps as `npm run setup:local-tts kokoro`; a voice:
// `… piper/en_US-ryan-high`), one at a time: they share the Python envs. A `.installing` file in the engine's model
// folder marks one that hasn't finished (failed, cancelled, or the app quit), so a half-downloaded model never counts
// as installed; Install again resumes it. Uninstall stops the engine and deletes its models, and the Python env once
// no engine that uses it is left. macOS's own engines (macos, apple) are built in.
// Everything goes into SPEECH_ROOT (the repo for `npm run dev`; Application Support in the packaged app).
// GET /api/speech/engines carries every engine's state; POST /api/speech/install starts, cancels or uninstalls one.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InstallState } from "../shared/protocol.ts";
import { APP_ROOT, SPEECH_ROOT } from "./paths.ts";
import { PIPER_CATALOG } from "./ttsVoices.ts";
import { LOCAL_TTS_FILES, stopLocalTts, type LocalEngine } from "./adapters/localTts.ts";
import { WHISPERKIT_MODEL, stopLocalStt, whisperKitCli, type LocalSttEngine } from "./adapters/localStt.ts";

const MB = 1024 * 1024;
const SENTINEL = ".installing";

type Kind = "tts" | "stt";
type Venv = ".venv-tts" | ".venv-stt";

export interface EngineSpec {
  kind: Kind;
  engine: string;
  builtin?: boolean;
  /** The Python env it runs in (repo root), shared with the other engines of its kind. */
  venv?: Venv;
  /** Its model folder, under .models/. */
  dir?: string;
  /** What must exist under .models/ for it to run. */
  needs?: string[];
  /** The models' usual size on disk (for the progress estimate and the download size). */
  modelBytes?: number;
  /** A tool it needs besides the models (WhisperKit's whisperkit-cli, from Homebrew). */
  tool?: "whisperkit-cli";
  /** What the script does after its downloads, while the bar can't measure it (WhisperKit compiles the model). */
  finishing?: string;
  /** Voices it can download one at a time once installed (Piper): each is `<dir>/<id>.onnx`. */
  voices?: readonly { id: string; bytes: number }[];
}

export const ENGINE_SPECS: readonly EngineSpec[] = [
  { kind: "tts", engine: "macos", builtin: true },
  { kind: "tts", engine: "kokoro", venv: ".venv-tts", dir: "kokoro", needs: LOCAL_TTS_FILES.kokoro, modelBytes: 337 * MB },
  { kind: "tts", engine: "piper", venv: ".venv-tts", dir: "piper", needs: LOCAL_TTS_FILES.piper, modelBytes: 121 * MB, voices: PIPER_CATALOG },
  { kind: "stt", engine: "parakeet", venv: ".venv-stt", dir: "parakeet", needs: ["parakeet"], modelBytes: 2355 * MB },
  { kind: "stt", engine: "apple", builtin: true },
  { kind: "stt", engine: "whisperkit", dir: "whisperkit", needs: [WHISPERKIT_MODEL], modelBytes: 1536 * MB, tool: "whisperkit-cli", finishing: "Compiling for the Neural Engine (a few minutes)" },
  { kind: "stt", engine: "moonshine", venv: ".venv-stt", dir: "moonshine", needs: ["moonshine"], modelBytes: 412 * MB },
];
/** The Python envs' usual size (added to the download size while the env isn't there). */
const VENV_BYTES: Record<Venv, number> = { ".venv-tts": 173 * MB, ".venv-stt": 614 * MB };

export interface InstallerOptions {
  /** Where the envs and .models/ go (trailing slash; default SPEECH_ROOT). */
  root?: string;
  specs?: readonly EngineSpec[];
  /** Run the install script with `args` (default: bash scripts/setup-local-<kind>.sh <args>). */
  run?: (spec: EngineSpec, root: string, args: string[]) => ChildProcess;
  hasTool?: (tool: "whisperkit-cli") => boolean;
  /** Kill an engine's helper before its models are deleted. */
  stop?: (kind: Kind, engine: string) => void;
  /** An install finished: start the engine if it's the selected one. */
  onInstalled?: (kind: Kind, engine: string) => void;
  /** How often to re-measure a running install's progress, ms. */
  progressMs?: number;
  /** Bytes the install's processes have received from the network (default: processTreeMeter, from nettop). */
  meter?: (pid: number) => Meter;
}

/** Bytes received by a process and everything it starts. */
export interface Meter { received(): number; stop(): void }

/**
 * Network bytes received by `rootPid` and its descendants, from `nettop`'s per-process counters (one sample a second).
 * The downloads' own files aren't enough to show progress: Hugging Face (Parakeet) and WhisperKit download each file
 * to a temp folder and move it into place only once it's whole. Processes that have exited (a curl per file) keep
 * counting. Without nettop it reads 0, and the folder sizes are all there is.
 */
export function processTreeMeter(rootPid: number): Meter {
  const latest = new Map<number, number>();
  const tree = new Set([rootPid]);
  // Under a pseudo-terminal (script -q): into a pipe, nettop holds its samples back in a buffer for many seconds.
  const nettop = spawn("script", ["-q", "/dev/null", "nettop", "-P", "-x", "-J", "bytes_in", "-s", "1", "-L", "0"], { stdio: ["ignore", "pipe", "ignore"] });
  nettop.on("error", () => {});
  let buf = "";
  nettop.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const m = /,[^,]*\.(\d+),(\d+),?$/.exec(line.trim());
      if (m) latest.set(Number(m[1]), Number(m[2]));
    }
  });
  // Which processes are in the tree: asked again each second, since the script starts new ones (curl, python, uv…).
  const scan = setInterval(() => {
    execFile("ps", ["-A", "-o", "pid=,ppid="], (err, out) => {
      if (err) return;
      const children = new Map<number, number[]>();
      for (const row of out.split("\n")) {
        const [pid, ppid] = row.trim().split(/\s+/).map(Number);
        if (pid && ppid !== undefined) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
      }
      const todo = [...tree];
      while (todo.length) for (const c of children.get(todo.pop()!) ?? []) if (!tree.has(c)) { tree.add(c); todo.push(c); }
    });
  }, 1000);
  return {
    received: () => [...tree].reduce((n, pid) => n + (latest.get(pid) ?? 0), 0),
    stop: () => { clearInterval(scan); nettop.kill(); },
  };
}

/**
 * A running install's bar: measured while the script says it's downloading (`Downloading …` lines), from the larger
 * of what its files and its network counters show; undefined (a busy bar) for the other steps (setting up Python,
 * Homebrew) and once the downloads are in, when `finishing` names what's left.
 */
export function downloadProgress(phase: string, fileBytes: number, netBytes: number, total: number): number | undefined {
  if (!/^Downloading\b/.test(phase) || total <= 0) return undefined;
  const p = Math.max(fileBytes, netBytes) / total;
  return p >= 0.98 ? undefined : p;
}

/** Where the GUI app finds uv, Homebrew and their tools (launched from Finder, its PATH is only the system's). */
export function toolPath(path = process.env.PATH ?? ""): string {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin"), join(homedir(), ".cargo", "bin")];
  const dirs = path.split(":").filter(Boolean);
  return [...dirs, ...extra.filter((d) => !dirs.includes(d))].join(":");
}

function runScript(spec: EngineSpec, root: string, args: string[]): ChildProcess {
  // The script ships with the app (unpacked from the asar); it installs into SPEECH_DATA_DIR. Its own process group,
  // so Cancel also stops the curl / python / brew it runs.
  mkdirSync(root, { recursive: true });
  return spawn("bash", [`${APP_ROOT}scripts/setup-local-${spec.kind}.sh`, ...args], {
    cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: toolPath(), SPEECH_DATA_DIR: root },
  });
}

/** Total size of the files under `path` (0 if it isn't there). */
export function dirBytes(path: string): number {
  let total = 0;
  let entries;
  try { entries = readdirSync(path, { recursive: true, withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (!e.isFile()) continue;
    try { total += statSync(join(e.parentPath, e.name)).size; } catch { /* gone meanwhile */ }
  }
  return total;
}

const fileBytes = (path: string): number => {
  try { return statSync(path).size; } catch { return 0; }
};

interface Job {
  state: "queued" | "installing" | "error";
  phase?: string;
  /** 0–1 while downloading; undefined for the steps that can't be measured. */
  progress?: number;
  /** Downloaded so far / about how much there is (while downloading). */
  received?: number;
  total?: number;
  error?: string;
  proc?: ChildProcess;
  cancelled?: boolean;
}

/** What one run of the script does: an engine's install, or one more voice. */
interface Task {
  spec: EngineSpec;
  key: string;
  args: string[];
  /** Marked unfinished while it runs (an engine's model folder). */
  sentinelDir?: string;
  /** The size of what it has downloaded into place so far. */
  fileBytes(): number;
  /** About how much it downloads. */
  totalBytes: number;
  done(): boolean;
  onDone?(): void;
}

export function createInstaller(opts: InstallerOptions = {}) {
  const root = opts.root ?? SPEECH_ROOT;
  const specs = opts.specs ?? ENGINE_SPECS;
  const run = opts.run ?? runScript;
  const hasTool = opts.hasTool ?? (() => !!whisperKitCli());
  const progressMs = opts.progressMs ?? 1000;
  const meter = opts.meter ?? processTreeMeter;
  const models = `${root}.models/`;
  const jobs = new Map<string, Job>();
  const diskCache = new Map<string, number>();
  let chain: Promise<void> = Promise.resolve();

  const key = (kind: Kind, engine: string) => `${kind}:${engine}`;
  const voiceKey = (kind: Kind, engine: string, voice: string) => `${kind}:${engine}:voice:${voice}`;
  const specOf = (kind: string, engine: string) => specs.find((s) => s.kind === kind && s.engine === engine);
  const active = (job: Job | undefined) => job?.state === "queued" || job?.state === "installing";

  function installed(spec: EngineSpec): boolean {
    if (spec.builtin) return true;
    if (spec.dir && existsSync(`${models}${spec.dir}/${SENTINEL}`)) return false;
    if (spec.venv && !existsSync(`${root}${spec.venv}/bin/python`)) return false;
    if (spec.tool && !hasTool(spec.tool)) return false;
    return (spec.needs ?? []).every((p) => existsSync(`${models}${p}`));
  }

  const voiceFile = (spec: EngineSpec, voice: string) => `${models}${spec.dir}/${voice}.onnx`;

  function state(spec: EngineSpec): InstallState {
    const base = { kind: spec.kind, engine: spec.engine };
    if (spec.builtin) return { ...base, builtin: true, installed: true, state: "idle" };
    const job = jobs.get(key(spec.kind, spec.engine));
    const isInstalled = !job || job.state === "error" ? installed(spec) : false;
    const out: InstallState = { ...base, installed: isInstalled, state: job?.state ?? "idle" };
    if (job?.phase) out.phase = job.phase;
    if (job?.progress !== undefined) out.progress = job.progress;
    if (job?.received !== undefined && job.total) { out.receivedBytes = job.received; out.totalBytes = job.total; }
    if (job?.error) out.error = job.error;
    if (isInstalled && spec.dir) {
      let bytes = diskCache.get(spec.engine);
      if (bytes === undefined) diskCache.set(spec.engine, bytes = dirBytes(`${models}${spec.dir}`));
      out.diskBytes = bytes;
    } else if (!isInstalled) {
      out.downloadBytes = (spec.modelBytes ?? 0) + (spec.venv && !existsSync(`${root}${spec.venv}/bin/python`) ? VENV_BYTES[spec.venv] : 0);
    }
    const prefix = `${key(spec.kind, spec.engine)}:voice:`;
    const voices = [...jobs].filter(([k]) => k.startsWith(prefix)).map(([k, j]) => ({
      voice: k.slice(prefix.length), state: j.state,
      ...(j.progress !== undefined ? { progress: j.progress } : {}), ...(j.error ? { error: j.error } : {}),
    }));
    if (voices.length) out.voices = voices;
    return out;
  }

  async function runJob(task: Task, job: Job): Promise<void> {
    if (job.cancelled) return;
    job.state = "installing";
    job.phase = "Starting";
    if (task.sentinelDir) {
      mkdirSync(task.sentinelDir, { recursive: true });
      writeFileSync(`${task.sentinelDir}/${SENTINEL}`, "");
    }
    diskCache.delete(task.spec.engine);
    const proc = run(task.spec, root, task.args);
    job.proc = proc;
    const net = proc.pid ? meter(proc.pid) : null;
    /** The network bytes before the first download (Python packages don't count towards the models). */
    let netBase: number | undefined;
    let tail = "";
    const keep = (d: Buffer) => { tail = (tail + d.toString()).slice(-4000); };
    proc.stdout?.on("data", (d: Buffer) => {
      keep(d);
      const line = d.toString().split("\n").map((l) => l.trim()).filter(Boolean).pop();
      if (line) job.phase = line;
    });
    proc.stderr?.on("data", keep);
    const timer = setInterval(() => {
      const phase = job.phase ?? "";
      const received = net?.received() ?? 0;
      if (/^Downloading\b/.test(phase)) netBase ??= received;
      const files = task.fileBytes();
      const got = Math.max(files, received - (netBase ?? received));
      const p = downloadProgress(phase, files, received - (netBase ?? received), task.totalBytes);
      if (p !== undefined) {
        job.progress = Math.max(job.progress ?? 0, p); // it never goes back
        job.received = got;
        job.total = task.totalBytes;
      } else {
        job.progress = undefined;
        job.received = undefined;
        // The downloads are in and the script is still at work: say what it's doing.
        if (/^Downloading\b/.test(phase) && got >= task.totalBytes * 0.98) job.phase = task.spec.finishing ?? "Finishing…";
      }
    }, progressMs);
    const code = await new Promise<number | null>((resolve) => {
      proc.once("error", (e) => { tail += `\n${e.message}`; resolve(-1); });
      proc.once("close", (c) => resolve(c));
    });
    clearInterval(timer);
    net?.stop();
    // Cancelled: the job is already gone (and a new Install may have queued another under the same key).
    if (job.cancelled || jobs.get(task.key) !== job) return;
    if (code === 0 && task.sentinelDir) {
      try { unlinkSync(`${task.sentinelDir}/${SENTINEL}`); } catch { /* already gone */ }
    }
    diskCache.delete(task.spec.engine);
    if (code === 0 && task.done()) {
      jobs.delete(task.key);
      task.onDone?.();
      return;
    }
    const lines = tail.split("\n").map((l) => l.trim()).filter(Boolean);
    jobs.set(task.key, { state: "error", error: lines.slice(-2).join(" · ") || `the install script exited (${code})` });
  }

  function queue(task: Task): void {
    const job: Job = { state: "queued" };
    jobs.set(task.key, job);
    chain = chain.then(() => runJob(task, job)).catch((e: unknown) => {
      jobs.set(task.key, { state: "error", error: e instanceof Error ? e.message : String(e) });
    });
  }

  function cancelKey(k: string): void {
    const job = jobs.get(k);
    if (!job || job.state === "error") return;
    job.cancelled = true;
    jobs.delete(k);
    const pid = job.proc?.pid;
    if (pid) {
      try { process.kill(-pid, "SIGTERM"); } catch { job.proc?.kill("SIGTERM"); }
    }
  }

  function requireSpec(kind: string, engine: string): EngineSpec {
    const spec = specOf(kind, engine);
    if (!spec) throw new Error(`unknown engine ${kind}:${engine}`);
    return spec;
  }

  return {
    /** Every engine's install state, in the specs' order. */
    states(): InstallState[] {
      return specs.map(state);
    },

    /** Queue an engine's install (a no-op while it's queued or running, or for a built-in one). */
    install(kind: string, engine: string): InstallState {
      const spec = requireSpec(kind, engine);
      const k = key(spec.kind, spec.engine);
      if (spec.builtin || active(jobs.get(k))) return state(spec);
      const dir = `${models}${spec.dir}`;
      queue({
        spec, key: k, args: [spec.engine], sentinelDir: dir,
        fileBytes: () => dirBytes(dir), totalBytes: spec.modelBytes ?? 0,
        done: () => installed(spec),
        onDone: () => opts.onInstalled?.(spec.kind, spec.engine),
      });
      return state(spec);
    },

    /** Queue the download of one more voice of an installed engine (Piper). A no-op once it's there or queued. */
    installVoice(kind: string, engine: string, voice: string): InstallState {
      const spec = requireSpec(kind, engine);
      const entry = spec.voices?.find((v) => v.id === voice);
      if (!entry) throw new Error(`${engine} has no voice ${voice}`);
      if (!installed(spec)) throw new Error(`install ${engine} first`);
      const k = voiceKey(spec.kind, spec.engine, voice);
      const file = voiceFile(spec, voice);
      if (active(jobs.get(k)) || existsSync(file)) return state(spec);
      queue({
        spec, key: k, args: [`${spec.engine}/${voice}`],
        fileBytes: () => fileBytes(file) || fileBytes(`${file}.part`), totalBytes: entry.bytes,
        done: () => existsSync(file) && existsSync(`${file}.json`),
      });
      return state(spec);
    },

    /** Stop a queued or running install. What it downloaded stays, so Install again resumes it. */
    cancel(kind: string, engine: string): void {
      const spec = specOf(kind, engine);
      if (spec) cancelKey(key(spec.kind, spec.engine));
    },

    cancelVoice(kind: string, engine: string, voice: string): void {
      const spec = specOf(kind, engine);
      if (spec) cancelKey(voiceKey(spec.kind, spec.engine, voice));
    },

    /** Stop the engine and delete its models (and its Python env when no other engine of its kind is left). */
    uninstall(kind: string, engine: string): void {
      const spec = requireSpec(kind, engine);
      if (spec.builtin) throw new Error("built into macOS: there's nothing to remove");
      const k = key(spec.kind, spec.engine);
      if ([...jobs].some(([jk, j]) => (jk === k || jk.startsWith(`${k}:voice:`)) && active(j))) {
        throw new Error("it's installing: cancel the install first");
      }
      (opts.stop ?? stopEngine)(spec.kind, spec.engine);
      if (spec.dir) rmSync(`${models}${spec.dir}`, { recursive: true, force: true });
      if (spec.venv && !specs.some((s) => s !== spec && s.venv === spec.venv && s.dir && existsSync(`${models}${s.dir}`))) {
        rmSync(`${root}${spec.venv}`, { recursive: true, force: true });
      }
      for (const jk of [...jobs.keys()]) if (jk === k || jk.startsWith(`${k}:voice:`)) jobs.delete(jk);
      diskCache.delete(spec.engine);
    },

    /** Resolves when every queued install has finished (tests). */
    idle(): Promise<void> {
      return chain;
    },
  };
}

function stopEngine(kind: Kind, engine: string): void {
  if (kind === "tts") stopLocalTts(engine as LocalEngine);
  else stopLocalStt(engine as LocalSttEngine);
}

export type Installer = ReturnType<typeof createInstaller>;

let installer: Installer | undefined;
/** The server's installer: a finished install starts the engine when it's the selected one. */
export function speechInstaller(): Installer {
  installer ??= createInstaller({
    onInstalled: () => {
      void import("./speechEngines.ts").then(({ currentSpeech, setSpeech }) => setSpeech(currentSpeech()));
    },
  });
  return installer;
}
