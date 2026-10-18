// On-device speech-to-text engines behind the SttStream interface, each a persistent helper that keeps its
// model loaded (not billed):
//   parakeet   — NVIDIA Parakeet TDT 0.6B v3 on MLX   (tools/localstt/server.py --engine parakeet)
//   moonshine  — Moonshine Voice medium, English       (tools/localstt/server.py --engine moonshine)
//   apple      — macOS 26 SpeechAnalyzer + SpeechTranscriber (tools/macstt/main.swift, compiled once)
//   whisperkit — WhisperKit large-v3 turbo on Core ML  (`whisperkit-cli serve`, OpenAI-style HTTP on a free 127.0.0.1 port)
// The first three speak a framed stdin/stdout protocol (see tools/macstt/main.swift): audio streams in while
// the key is held and partials come back (Apple from the recognizer, Parakeet/Moonshine by re-transcribing
// the clip so far). WhisperKit is batch: the clip is POSTed as a WAV on commit, like openRouterStt.ts.
// Word times are seconds from the first sample, the same convention as Scribe, so pointing works unchanged.
// The server starts only the selected engine (server/speechEngines.ts) and kills it when another is picked; the
// Python ones and WhisperKit's model need `npm run setup:local-stt` once.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import type { Word } from "../../shared/protocol.ts";
import type { OpenScribe, SttStream } from "./types.ts";
import { pcmToWav } from "./openRouterStt.ts";
import { APP_ROOT, SPEECH_ROOT } from "../paths.ts";
import { EngineHost } from "./engineHost.ts";

export type LocalSttEngine = "parakeet" | "apple" | "whisperkit" | "moonshine";
export const LOCAL_STT_ENGINES: readonly LocalSttEngine[] = ["parakeet", "apple", "whisperkit", "moonshine"];

const ROOT = APP_ROOT;
const VENV_PY = `${SPEECH_ROOT}.venv-stt/bin/python`;
const MODELS = `${SPEECH_ROOT}.models`;
const SCRIPT = `${ROOT}tools/localstt/server.py`;
/** WhisperKit's model folder under .models/ (server/speechInstall.ts checks it too). */
export const WHISPERKIT_MODEL = "whisperkit/models/argmaxinc/whisperkit-coreml/openai_whisper-large-v3-v20240930_turbo";
export const WHISPERKIT_MODEL_DIR = `${MODELS}/${WHISPERKIT_MODEL}`;
/** WhisperKit's port: WHISPERKIT_PORT, else a free one picked at launch (so two app instances don't collide). */
let whisperKitPort = Number(process.env.WHISPERKIT_PORT) || 0;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}
const BYTES_PER_SEC = 24000 * 2;
/** Give up on a final transcript after this long. */
const FINAL_TIMEOUT_MS = 20_000;


type Final = { text: string; words: Word[]; language?: string };

interface EngineSpec {
  label: string;
  /** Command to start the helper (throws with a fix-it message if it isn't installed). */
  launch: () => Promise<{ cmd: string; args: string[] }>;
}

function pythonEngine(engine: "parakeet" | "moonshine", dir: string): EngineSpec["launch"] {
  return async () => {
    const missing = [VENV_PY, `${MODELS}/${dir}`].filter((f) => !existsSync(f));
    if (missing.length) throw new Error(`not installed (Settings → Speech to text → Install): missing ${missing.map((m) => m.replace(SPEECH_ROOT, "")).join(", ")}`);
    return { cmd: VENV_PY, args: ["-I", SCRIPT, "--engine", engine, "--models", MODELS] };
  };
}

/** whisperkit-cli from Homebrew (the Electron app's PATH may not include /opt/homebrew/bin). */
export function whisperKitCli(): string | undefined {
  for (const dir of [...(process.env.PATH ?? "").split(":"), "/opt/homebrew/bin", "/usr/local/bin"]) {
    if (dir && existsSync(`${dir}/whisperkit-cli`)) return `${dir}/whisperkit-cli`;
  }
}

const ENGINES: Record<LocalSttEngine, EngineSpec> = {
  parakeet: { label: "Parakeet TDT 0.6B v3 (local)", launch: pythonEngine("parakeet", "parakeet") },
  moonshine: { label: "Moonshine (local)", launch: pythonEngine("moonshine", "moonshine") },
  apple: {
    label: "Apple SpeechTranscriber",
    launch: async () => {
      const { buildSwiftHelper } = await import("./macTts.ts");
      return { cmd: await buildSwiftHelper("macstt"), args: [] };
    },
  },
  whisperkit: {
    label: "WhisperKit (local)",
    launch: async () => {
      const cli = whisperKitCli();
      if (!cli || !existsSync(WHISPERKIT_MODEL_DIR)) throw new Error("not installed (Settings → Speech to text → Install): needs whisperkit-cli and the large-v3 turbo model");
      if (!process.env.WHISPERKIT_PORT) whisperKitPort = await freePort();
      return { cmd: cli, args: ["serve", "--model-path", WHISPERKIT_MODEL_DIR, "--word-timestamps", "--host", "127.0.0.1", "--port", String(whisperKitPort)] };
    },
  },
};

interface Pending { onPartial: (t: string) => void; resolve: (r: Final & { ms?: number }) => void; reject: (e: Error) => void }

/** A helper process. Framed engines get sessions over stdin; WhisperKit's is ready once its HTTP server is up. */
export class SttHelper {
  private proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private pending = new Map<string, Pending>();
  private seq = 0;
  private stderr = "";
  readonly ready: Promise<void>;
  dead = false;
  get pid(): number | undefined { return this.proc.pid; }

  constructor(readonly name: LocalSttEngine, cmd: string, args: string[]) {
    this.proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let markReady!: () => void, failReady!: (e: Error) => void;
    this.ready = new Promise((res, rej) => { markReady = res; failReady = rej; });
    this.ready.catch(() => {});
    this.proc.stdout.on("data", (d: Buffer) => this.onData(d.toString(), markReady));
    this.proc.stderr.on("data", (d: Buffer) => { this.stderr = (this.stderr + d.toString()).slice(-2000); });
    this.proc.on("error", (e) => failReady(e));
    this.proc.on("close", (code) => {
      this.dead = true;
      failReady(new Error(`${name} helper exited (${code}) before it was ready: ${this.stderr.trim().split("\n").slice(-3).join(" | ")}`));
      for (const p of this.pending.values()) p.reject(new Error(`${name} helper exited`));
      this.pending.clear();
    });
  }

  private onData(d: string, markReady: () => void): void {
    this.buf += d;
    for (let nl = this.buf.indexOf("\n"); nl >= 0; nl = this.buf.indexOf("\n")) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (this.name === "whisperkit") { // plain log lines: "[ NOTICE ] Server started on http://…"
        if (line.includes("Server started")) markReady();
        continue;
      }
      let h: { id?: string; ready?: boolean; partial?: string; final?: boolean; text?: string; words?: Word[]; ms?: number; error?: string };
      try { h = JSON.parse(line); } catch { continue; }
      if (h.ready) { markReady(); continue; }
      const p = h.id ? this.pending.get(h.id) : undefined;
      if (!p) continue;
      if (typeof h.partial === "string") p.onPartial(h.partial);
      else if (h.final) { this.pending.delete(h.id!); p.resolve({ text: h.text ?? "", words: h.words ?? [], ms: h.ms }); }
      else if (h.error) { this.pending.delete(h.id!); p.reject(new Error(`${this.name}: ${h.error}`)); }
    }
  }

  private send(header: Record<string, unknown>, bytes?: Buffer): void {
    if (this.dead) return;
    this.proc.stdin.write(JSON.stringify(header) + "\n");
    if (bytes) this.proc.stdin.write(bytes);
  }

  /** Open a streaming session (framed engines). */
  session(lang: string, onPartial: (t: string) => void) {
    if (this.dead) throw new Error(`${this.name} helper isn't running`);
    const id = String(++this.seq);
    let resolve!: Pending["resolve"], reject!: Pending["reject"];
    const result = new Promise<Final & { ms?: number }>((res, rej) => { resolve = res; reject = rej; });
    result.catch(() => {});
    this.pending.set(id, { onPartial, resolve, reject });
    this.send({ id, cmd: "start", lang });
    return {
      result,
      push: (pcm: Buffer) => this.send({ id, pcm: pcm.length }, pcm),
      commit: () => this.send({ id, cmd: "commit" }),
      cancel: () => {
        if (!this.pending.delete(id)) return;
        this.send({ id, cmd: "cancel" });
        reject(new Error(`${this.name}: closed before final`));
      },
    };
  }

  kill(): void { if (!this.dead) this.proc.kill("SIGTERM"); }
}

const host = new EngineHost<LocalSttEngine, SttHelper>(
  "local-stt",
  Object.fromEntries(LOCAL_STT_ENGINES.map((e) => [e, ENGINES[e].label])) as Record<LocalSttEngine, string>,
  async (engine) => {
    const { cmd, args } = await ENGINES[engine].launch();
    return new SttHelper(engine, cmd, args);
  },
);

export function setLocalSttLogger(fn: (msg: string) => void): void { host.log = fn; }
/** Start an engine's helper (model loaded + warmed). Idempotent. */
export const startLocalStt = (engine: LocalSttEngine): Promise<void> => host.start(engine);
/** Kill an engine's helper (all of them without an argument). */
export const stopLocalStt = (engine?: LocalSttEngine): void => host.stop(engine);
/** The engines that are loading or running (and failed starts). */
export const localSttStates = () => host.states();
const getHelper = (engine: LocalSttEngine): Promise<SttHelper> => host.get(engine);

/** WhisperKit's server: the clip as one WAV, verbose_json with word timestamps. */
async function whisperKitTranscribe(pcm: Buffer, language: string | undefined, signal: AbortSignal): Promise<Final> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(pcmToWav(pcm))], { type: "audio/wav" }), "clip.wav");
  form.append("model", "whisper");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  if (language) form.append("language", language);
  const res = await fetch(`http://127.0.0.1:${whisperKitPort}/v1/audio/transcriptions`, { method: "POST", body: form, signal });
  if (!res.ok) throw new Error(`WhisperKit ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const j = (await res.json()) as { text?: unknown; language?: unknown; words?: { word?: unknown; start?: unknown; end?: unknown }[] };
  const words = (Array.isArray(j.words) ? j.words : [])
    .filter((w) => w && typeof w.word === "string" && (w.word as string).trim())
    .map((w) => ({ text: (w.word as string).trim(), start: Number(w.start), end: Number(w.end) })); // words carry a leading space
  return { text: typeof j.text === "string" ? j.text.trim() : "", words, ...(typeof j.language === "string" ? { language: j.language } : {}) };
}

/** An on-device engine behind the same interface as Scribe. */
export function openLocalStt(engine: LocalSttEngine): OpenScribe {
  return async ({ mark, language }) => {
    const helper = await getHelper(engine);
    const partialCbs: ((t: string) => void)[] = [];
    let bytes = 0;
    let committed = false;
    let closed = false;
    let firstPartial = false;
    let tCommit = 0;
    const timeout = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onPartial = (t: string) => {
      if (closed) return;
      if (!firstPartial) { firstPartial = true; mark("stt.firstPartial", { text: t, model: engine }); }
      for (const cb of partialCbs) cb(t);
    };

    // WhisperKit: buffer the clip, transcribe on commit. The others: stream into a helper session.
    const chunks: Buffer[] = [];
    const sess = engine === "whisperkit" ? null : helper.session(language ?? "en", onPartial);
    let resolveBatch!: (r: Final & { ms?: number }) => void, rejectBatch!: (e: Error) => void;
    const batch = new Promise<Final & { ms?: number }>((res, rej) => { resolveBatch = res; rejectBatch = rej; });
    batch.catch(() => {});

    const finalP: Promise<Final> = (sess ? sess.result : batch).then((r) => {
      clearTimeout(timer);
      mark("stt.final", { words: r.words.length, model: engine, commitToFinalMs: Math.round(performance.now() - tCommit), ...(r.ms !== undefined ? { engineMs: r.ms } : {}) });
      return { text: r.text, words: r.words, ...(r.language ? { language: r.language } : {}) };
    });
    finalP.catch(() => clearTimeout(timer));

    const stream: SttStream = {
      pushAudio(pcm24k) {
        if (committed || closed || pcm24k.length === 0) return; // audio after release is ignored
        bytes += pcm24k.length;
        if (sess) sess.push(pcm24k);
        else chunks.push(pcm24k);
      },
      commit() {
        if (committed || closed) return;
        committed = true;
        tCommit = performance.now();
        timer = setTimeout(() => {
          timeout.abort();
          sess?.cancel();
          rejectBatch(new Error(`${engine}: no transcript after ${FINAL_TIMEOUT_MS / 1000} s`));
        }, FINAL_TIMEOUT_MS);
        if (sess) return sess.commit();
        const pcm = Buffer.concat(chunks.splice(0));
        if (!pcm.length) return resolveBatch({ text: "", words: [] });
        whisperKitTranscribe(pcm, language, timeout.signal).then(resolveBatch, rejectBatch);
      },
      onPartial(cb) { partialCbs.push(cb); },
      final: () => finalP,
      close() {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        timeout.abort();
        sess?.cancel();
        rejectBatch(new Error(`${engine}: closed before final`));
      },
      get seconds() { return bytes / BYTES_PER_SEC; },
    };
    return stream;
  };
}
