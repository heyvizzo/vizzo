// On-device text-to-speech engines behind the TtsStream interface, each a persistent helper process that
// keeps its model loaded and streams PCM16 24 kHz with the framed protocol of tools/mactts:
//   macos  — AVSpeechSynthesizer (tools/mactts/main.swift, compiled once)
//   kokoro — Kokoro-82M ONNX      (tools/localtts/server.py --engine kokoro)
//   piper  — Piper, en_US lessac + ro_RO mihai (tools/localtts/server.py --engine piper)
// `npm run dev` starts all available engines (startLocalTts) so the first sentence doesn't pay a model
// load; Kokoro/Piper need `npm run setup:local-tts` once. Text goes a sentence at a time (Kokoro also
// splits long sentences at clauses: it synthesizes a whole piece before returning any audio); the voice
// follows the turn's language, resolved per piece.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { OpenTts, TtsStream } from "./types.ts";
import { splitClauses, takeSentences } from "./sentences.ts";

export type LocalEngine = "macos" | "kokoro" | "piper";
export const LOCAL_ENGINES: readonly LocalEngine[] = ["macos", "kokoro", "piper"];

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VENV_PY = `${ROOT}.venv-tts/bin/python`;
const MODELS = `${ROOT}.models`;
const SCRIPT = `${ROOT}tools/localtts/server.py`;

let log: (msg: string) => void = (msg) => console.info(msg);
export function setLocalTtsLogger(fn: (msg: string) => void): void { log = fn; }

interface EngineSpec {
  label: string;
  /** Command to start the helper (throws with a fix-it message if it isn't installed). */
  launch: () => Promise<{ cmd: string; args: string[] }>;
  /** Split long sentences at clause boundaries (engines that only return audio for a whole piece). */
  clauses?: boolean;
}

function pythonEngine(engine: "kokoro" | "piper", files: string[]): EngineSpec["launch"] {
  return async () => {
    const missing = [VENV_PY, ...files.map((f) => `${MODELS}/${f}`)].filter((f) => !existsSync(f));
    if (missing.length) throw new Error(`not installed (run \`npm run setup:local-tts\`): missing ${missing.map((m) => m.replace(ROOT, "")).join(", ")}`);
    return { cmd: VENV_PY, args: ["-I", SCRIPT, "--engine", engine, "--models", MODELS] };
  };
}

const ENGINES: Record<LocalEngine, EngineSpec> = {
  macos: {
    label: "macOS on-device TTS",
    launch: async () => {
      const { buildMacTts } = await import("./macTts.ts");
      return { cmd: await buildMacTts(), args: [] };
    },
  },
  kokoro: {
    label: "Kokoro (local)",
    launch: pythonEngine("kokoro", ["kokoro/kokoro-v1.0.onnx", "kokoro/voices-v1.0.bin"]),
    clauses: true,
  },
  piper: {
    label: "Piper (local)",
    launch: pythonEngine("piper", ["piper/en_US-lessac-medium.onnx", "piper/ro_RO-mihai-medium.onnx"]),
  },
};

type Pending = { onPcm: (b: Buffer) => void; resolve: (r: { voice: string; ms: number }) => void; reject: (e: Error) => void };

/** A helper process speaking the framed protocol (JSON header line + PCM bytes). Requests run one at a time. */
export class FramedHelper {
  private proc: ChildProcessWithoutNullStreams;
  private buf = Buffer.alloc(0);
  private pending = new Map<string, Pending>();
  private seq = 0;
  private stderr = "";
  readonly ready: Promise<void>;
  dead = false;

  constructor(readonly name: string, cmd: string, args: string[]) {
    this.proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let markReady!: () => void, failReady!: (e: Error) => void;
    this.ready = new Promise((res, rej) => { markReady = res; failReady = rej; });
    this.ready.catch(() => {});
    this.proc.stdout.on("data", (d: Buffer) => this.onData(d, markReady));
    this.proc.stderr.on("data", (d: Buffer) => { this.stderr = (this.stderr + d.toString()).slice(-2000); });
    this.proc.on("error", (e) => failReady(e));
    this.proc.on("close", (code) => {
      this.dead = true;
      failReady(new Error(`${name} helper exited (${code}) before it was ready: ${this.stderr.trim().split("\n").slice(-3).join(" | ")}`));
      for (const p of this.pending.values()) p.reject(new Error(`${name} helper exited`));
      this.pending.clear();
    });
  }

  private onData(d: Buffer, markReady: () => void): void {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const nl = this.buf.indexOf(10);
      if (nl < 0) return;
      let h: { id?: string; pcm?: number; done?: boolean; error?: string; ready?: boolean; voice?: string; ms?: number };
      try { h = JSON.parse(this.buf.subarray(0, nl).toString()); } catch { this.buf = this.buf.subarray(nl + 1); continue; }
      if (h.pcm !== undefined) {
        if (this.buf.length < nl + 1 + h.pcm) return; // wait for the whole frame
        const pcm = Buffer.from(this.buf.subarray(nl + 1, nl + 1 + h.pcm));
        this.buf = this.buf.subarray(nl + 1 + h.pcm);
        if (h.id) this.pending.get(h.id)?.onPcm(pcm);
        continue;
      }
      this.buf = this.buf.subarray(nl + 1);
      if (h.ready) markReady();
      const p = h.id ? this.pending.get(h.id) : undefined;
      if (!p) continue;
      if (h.done) { this.pending.delete(h.id!); p.resolve({ voice: h.voice ?? "", ms: h.ms ?? 0 }); }
      else if (h.error) { this.pending.delete(h.id!); p.reject(new Error(`${this.name}: ${h.error}`)); }
    }
  }

  /** Synthesize one piece of text; PCM arrives through onPcm in order. */
  say(text: string, lang: string, onPcm: (b: Buffer) => void, voice?: string): Promise<{ voice: string; ms: number }> {
    if (this.dead) return Promise.reject(new Error(`${this.name} helper isn't running`));
    const id = String(++this.seq);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { onPcm, resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, text, lang, ...(voice ? { voice } : {}) }) + "\n");
    });
  }

  /** Load and warm a voice ahead of use (no reply needed; requests after it run once it's loaded). */
  load(voice: string): void {
    if (!this.dead) this.proc.stdin.write(JSON.stringify({ cmd: "load", voice }) + "\n");
  }

  kill(): void { if (!this.dead) this.proc.kill("SIGTERM"); }
}

const helpers = new Map<LocalEngine, Promise<FramedHelper>>();

/** Start an engine's helper (model loaded + voices warmed). `npm run dev` calls this for every engine. Idempotent. */
export function startLocalTts(engine: LocalEngine): Promise<void> {
  let h = helpers.get(engine);
  if (!h) {
    const spec = ENGINES[engine];
    const t0 = performance.now();
    h = spec.launch().then(async ({ cmd, args }) => {
      const helper = new FramedHelper(engine, cmd, args);
      process.once("exit", () => helper.kill());
      await helper.ready;
      log(`[local-tts] ${spec.label} ready in ${Math.round(performance.now() - t0)} ms (model loaded, voices warmed)`);
      return helper;
    });
    helpers.set(engine, h);
    h.catch((e) => {
      log(`[local-tts] ${spec.label} unavailable: ${e instanceof Error ? e.message : String(e)}`);
      if (helpers.get(engine) === h) helpers.delete(engine);
    });
  }
  return h.then(() => {});
}

async function getHelper(engine: LocalEngine): Promise<FramedHelper> {
  if (!helpers.has(engine)) startLocalTts(engine).catch(() => {});
  const h = await helpers.get(engine)!;
  if (h.dead) { helpers.delete(engine); return getHelper(engine); }
  return h;
}

export function stopLocalTts(engine?: LocalEngine): void {
  for (const e of engine ? [engine] : LOCAL_ENGINES) {
    helpers.get(e)?.then((h) => h.kill(), () => {});
    helpers.delete(e);
  }
}

/** Which engines are running (for /api/health). */
export async function localTtsStatus(): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const e of LOCAL_ENGINES) {
    const h = helpers.get(e);
    out[e] = h ? await h.then((x) => !x.dead, () => false) : false;
  }
  return out;
}

/** An on-device engine behind the same interface as ElevenLabs. */
export function openLocalTts(engine: LocalEngine): OpenTts {
  return async ({ mark, segment, language, voice }) => {
    const h = await getHelper(engine);
    // Streams are opened when the user presses talk: start loading a non-default voice right away.
    if (voice) h.load(voice);
    // Resolved per piece: a stream opened before the transcript exists learns the language later.
    const lang = () => ((typeof language === "function" ? language() : language) === "ro" ? "ro" : "en");
    const clauses = ENGINES[engine].clauses;
    const audioCbs: ((b: Buffer) => void)[] = [];
    const early: Buffer[] = [];
    let rest = "";
    let chars = 0;
    let closed = false;
    let flushed = false;
    let firstByte = false;
    const jobs: Promise<unknown>[] = [];
    const t0 = performance.now();

    const onPcm = (b: Buffer) => {
      if (closed) return;
      if (!firstByte) {
        firstByte = true;
        mark(segment === "answer" ? "answer.ttsFirstByte" : "ack.ttsFirstByte", { model: engine, ...(voice ? { voice } : {}), bytes: b.length, ms: Math.round(performance.now() - t0) });
      }
      if (audioCbs.length) for (const cb of audioCbs) cb(b);
      else early.push(b);
    };
    const speak = (text: string) => {
      if (!text.trim() || closed) return;
      for (const piece of clauses ? splitClauses(text) : [text]) {
        const p = h.say(piece, lang(), onPcm, voice);
        p.catch(() => {});
        jobs.push(p);
      }
    };

    const stream: TtsStream = {
      pushText(delta) {
        if (closed || flushed || !delta) return;
        chars += delta.length;
        const [sentences, tail] = takeSentences(rest + delta);
        rest = tail;
        for (const s of sentences) speak(s);
      },
      flush() {
        if (flushed) return;
        flushed = true;
        speak(rest);
        rest = "";
      },
      onAudio(cb) {
        audioCbs.push(cb);
        for (const b of early.splice(0)) cb(b);
      },
      async done() {
        stream.flush();
        await Promise.all(jobs);
      },
      close() { closed = true; },
      get chars() { return chars; },
    };
    return stream;
  };
}
