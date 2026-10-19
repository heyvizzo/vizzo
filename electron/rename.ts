// The app was "Voice Latency Lab" (packaged) and "realtime-voice-latency-lab" (`npm run dev`) before it was Vizzo.
// On the first run under the new name, what the old names kept moves over: the settings folder (settings, sign-ins,
// speech models, turn logs) and ~/.config/realtime-voice (dev's LLM / speech selections). The API keys in it are
// encrypted with the old name's Keychain password, so they're decrypted with that once (macOS asks), saved again
// under the new one, and the old Keychain entry is deleted.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import { dirname } from "node:path";
import { keychainCipher, keychainService, openEnv, type StoredEnv } from "./secrets.ts";

export const LEGACY_NAMES = { packaged: "Voice Latency Lab", dev: "realtime-voice-latency-lab", config: "realtime-voice" } as const;

export interface DirFs {
  exists(path: string): boolean;
  isEmpty(path: string): boolean;
  /** Moves `from` to `to`, replacing `to` if it's an empty folder. */
  move(from: string, to: string): void;
}
const realFs: DirFs = {
  exists: existsSync,
  isEmpty: (path) => readdirSync(path).length === 0,
  move: (from, to) => {
    if (existsSync(to)) rmdirSync(to); // only ever empty: rmdir won't delete a folder with anything in it
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  },
};

/**
 * Moves `from` to `to` when `from` exists and `to` is missing or empty (Electron makes the userData folder, empty,
 * before main.ts runs; it fills it once the app is ready). True when it moved.
 */
export function moveLegacyDir(from: string, to: string, fs: DirFs = realFs): boolean {
  if (!fs.exists(from) || (fs.exists(to) && !fs.isEmpty(to))) return false;
  try {
    fs.move(from, to);
    return true;
  } catch (err) {
    console.error(`[rename] couldn't move ${from} to ${to}:`, err);
    return false;
  }
}

/**
 * The `unreadable` secrets in `stored`, decrypted with the old name's Keychain password. Once they all decrypt, the
 * old Keychain entry goes (the caller saves them under the new one). Empty when there's no old entry or macOS refused.
 */
export function legacySecrets(stored: StoredEnv, unreadable: readonly string[], secretKeys: readonly string[], legacyName: string,
  cipher = keychainCipher(legacyName), forget = deleteKeychainEntry): Record<string, string> {
  const secrets = Object.fromEntries(unreadable.flatMap((key) => (stored.secrets?.[key] ? [[key, stored.secrets[key]]] : [])));
  if (!Object.keys(secrets).length) return {};
  const opened = openEnv({ secrets }, secretKeys, cipher);
  if (Object.keys(opened.env).length && !opened.unreadable.length) forget(legacyName);
  return opened.env;
}

/** Deletes an app's safeStorage Keychain entry (deleting needs no permission; reading it would). */
function deleteKeychainEntry(appName: string): void {
  const { service, account } = keychainService(appName);
  try {
    execFileSync("security", ["delete-generic-password", "-s", service, "-a", account], { stdio: "ignore", timeout: 10_000 });
  } catch { /* already gone */ }
}
