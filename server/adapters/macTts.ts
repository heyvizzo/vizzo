// On-device text-to-speech (macOS AVSpeechSynthesizer) through a persistent Swift helper
// (tools/mactts/main.swift). The helper is compiled once (cached by source hash) and started by
// `npm run dev`; it keeps the voices loaded and streams PCM16 24 kHz as it synthesizes (~60–90 ms to
// first audio once warm). Same TtsStream interface as ElevenLabs: text is sent a sentence at a time
// (and the rest on flush); voices follow the language (en → best en-US voice, ro → Ioana).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { OpenTts } from "./types.ts";
import { openLocalTts, setLocalTtsLogger, startLocalTts, stopLocalTts } from "./localTts.ts";
import { takeSentences } from "./sentences.ts";
import { APP_ROOT } from "../paths.ts";

export { takeSentences };

const ROOT = APP_ROOT;

let log: (msg: string) => void = (msg) => console.info(msg);

/**
 * Compile tools/<name>/main.swift if needed (cached by source hash); returns the binary path. The packaged app ships
 * them compiled (dist-native/, scripts/build-native.sh): a Mac without Xcode's tools has no swiftc.
 */
export async function buildSwiftHelper(name: string): Promise<string> {
  if (process.platform !== "darwin") throw new Error(`${name} needs macOS`);
  const source = `${ROOT}tools/${name}/main.swift`;
  const hash = createHash("sha1").update(readFileSync(source)).digest("hex").slice(0, 10);
  const prebuilt = `${ROOT}dist-native/${name}-${hash}`;
  if (existsSync(prebuilt)) return prebuilt;
  const bin = join(`${ROOT}node_modules/.cache/${name}/`, `${name}-${hash}`);
  if (existsSync(bin)) return bin;
  mkdirSync(dirname(bin), { recursive: true });
  const t0 = performance.now();
  await promisify(execFile)("swiftc", ["-O", "-o", bin, source]);
  log(`[${name}] compiled the on-device helper in ${Math.round(performance.now() - t0)} ms`);
  return bin;
}

/** Compile the TTS helper if needed; returns the binary path. */
export const buildMacTts = (): Promise<string> => buildSwiftHelper("mactts");

// The helper process, its framed protocol and the TtsStream implementation are shared with the other
// on-device engines (localTts.ts); these keep the macOS-specific names.
export const startMacTts = (): Promise<void> => startLocalTts("macos");
export const stopMacTts = (): void => stopLocalTts("macos");
export const openMacTts: OpenTts = openLocalTts("macos");
export const setMacTtsLogger = (fn: (msg: string) => void): void => { log = fn; setLocalTtsLogger(fn); };
