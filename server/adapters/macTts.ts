// On-device text-to-speech (macOS AVSpeechSynthesizer) through a persistent Swift helper
// (tools/mactts/main.swift). The helper is compiled once (cached by source hash) and started by
// `npm run dev`; it keeps the voices loaded and streams PCM16 24 kHz as it synthesizes (~60–90 ms to
// first audio once warm). Same TtsStream interface as ElevenLabs: text is sent a sentence at a time
// (and the rest on flush); voices follow the language (en → best en-US voice, ro → Ioana).
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { OpenTts, TtsStream } from "./types.ts";

const SOURCE = fileURLToPath(new URL("../../tools/mactts/main.swift", import.meta.url));
const CACHE = fileURLToPath(new URL("../../node_modules/.cache/mactts/", import.meta.url));

let log: (msg: string) => void = (msg) => console.info(msg);
export function setMacTtsLogger(fn: (msg: string) => void): void { log = fn; }

/** Compile the helper if needed; returns the binary path. */
export async function buildMacTts(): Promise<string> {
  if (process.platform !== "darwin") throw new Error("on-device TTS needs macOS");
  const hash = createHash("sha1").update(readFileSync(SOURCE)).digest("hex").slice(0, 10);
  const bin = join(CACHE, `mactts-${hash}`);
  if (existsSync(bin)) return bin;
  mkdirSync(dirname(bin), { recursive: true });
  const t0 = performance.now();
  await promisify(execFile)("swiftc", ["-O", "-o", bin, SOURCE]);
  log(`[mactts] compiled the on-device TTS helper in ${Math.round(performance.now() - t0)} ms`);
  return bin;
}

type Pending = { onPcm: (b: Buffer) => void; resolve: (r: { voice: string; ms: number }) => void; reject: (e: Error) => void };

class Helper {
  private proc: ChildProcessWithoutNullStreams;
  private buf = Buffer.alloc(0);
  private pending = new Map<string, Pending>();
  private seq = 0;
  readonly ready: Promise<void>;
  dead = false;

  constructor(bin: string) {
    this.proc = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
    let markReady!: () => void;
    this.ready = new Promise((r) => (markReady = r));
    this.proc.stdout.on("data", (d: Buffer) => this.onData(d, markReady));
    this.proc.stderr.on("data", (d: Buffer) => log(`[mactts] ${d.toString().trim()}`));
    this.proc.on("close", () => {
      this.dead = true;
      for (const p of this.pending.values()) p.reject(new Error("on-device TTS helper exited"));
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
      else if (h.error) { this.pending.delete(h.id!); p.reject(new Error(`on-device TTS: ${h.error}`)); }
    }
  }

  /** Synthesize one piece of text; PCM arrives through onPcm in order. Requests run one at a time. */
  say(text: string, lang: string, onPcm: (b: Buffer) => void): Promise<{ voice: string; ms: number }> {
    if (this.dead) return Promise.reject(new Error("on-device TTS helper isn't running"));
    const id = String(++this.seq);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { onPcm, resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, text, lang }) + "\n");
    });
  }

  kill(): void { if (!this.dead) this.proc.kill("SIGTERM"); }
}

let helper: Promise<Helper> | null = null;

/** Build (if needed) and start the helper; `npm run dev` calls this at server start. Idempotent. */
export function startMacTts(): Promise<void> {
  if (!helper) {
    helper = buildMacTts().then((bin) => {
      const h = new Helper(bin);
      process.once("exit", () => h.kill());
      return h.ready.then(() => { log("[mactts] on-device TTS ready (voices warmed)"); return h; });
    });
    helper.catch((e) => { log(`[mactts] unavailable: ${e instanceof Error ? e.message : String(e)}`); helper = null; });
  }
  return helper.then(() => {});
}

async function getHelper(): Promise<Helper> {
  const h = await (helper ?? (startMacTts(), helper!));
  if (h.dead) { helper = null; return getHelper(); }
  return h;
}

export function stopMacTts(): void {
  helper?.then((h) => h.kill(), () => {});
  helper = null;
}

/** Split off complete sentences ("…. " / "…? " / "…! "); returns [sentences, rest]. */
export function takeSentences(text: string): [string[], string] {
  const out: string[] = [];
  const re = /[^.!?…]*[.!?…]+["'”’)]*(\s+|$)/gy;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && m[0].length) {
    if (!m[1] && m.index + m[0].length === text.length) break; // sentence end at the very end: wait for more (or flush)
    out.push(m[0].trim());
    last = re.lastIndex;
  }
  return [out.filter(Boolean), text.slice(last)];
}

/** On-device TTS behind the same interface as ElevenLabs (model "macos"). */
export const openMacTts: OpenTts = async ({ mark, segment, language }) => {
  const h = await getHelper();
  // Resolved per sentence: a socket opened before the transcript exists learns the language later.
  const lang = () => ((typeof language === "function" ? language() : language) === "ro" ? "ro" : "en");
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
      mark(segment === "answer" ? "answer.ttsFirstByte" : "ack.ttsFirstByte", { model: "macos", bytes: b.length, ms: Math.round(performance.now() - t0) });
    }
    if (audioCbs.length) for (const cb of audioCbs) cb(b);
    else early.push(b);
  };
  const speak = (text: string) => {
    if (!text.trim() || closed) return;
    const p = h.say(text, lang(), onPcm);
    p.catch(() => {});
    jobs.push(p);
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
