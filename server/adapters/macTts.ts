// On-device text-to-speech (macOS AVSpeechSynthesizer) through a persistent Swift helper
// (tools/mactts/main.swift). The helper is compiled once (cached by source hash) and started by
// `npm run dev`; it keeps the voices loaded and streams PCM16 24 kHz as it synthesizes (~60–90 ms to
// first audio once warm). Same TtsStream interface as ElevenLabs: text is sent a sentence at a time
// (and the rest on flush); voices follow the language (en → best en-US voice, ro → Ioana).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { OpenTts } from "./types.ts";
import { openLocalTts, setLocalTtsLogger, startLocalTts, stopLocalTts } from "./localTts.ts";
import { takeSentences } from "./sentences.ts";

export { takeSentences };

const SOURCE = fileURLToPath(new URL("../../tools/mactts/main.swift", import.meta.url));
const CACHE = fileURLToPath(new URL("../../node_modules/.cache/mactts/", import.meta.url));

let log: (msg: string) => void = (msg) => console.info(msg);

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

// The helper process, its framed protocol and the TtsStream implementation are shared with the other
// on-device engines (localTts.ts); these keep the macOS-specific names.
export const startMacTts = (): Promise<void> => startLocalTts("macos");
export const stopMacTts = (): void => stopLocalTts("macos");
export const openMacTts: OpenTts = openLocalTts("macos");
export const setMacTtsLogger = (fn: (msg: string) => void): void => { log = fn; setLocalTtsLogger(fn); };
