// The API keys are never written to disk in plain text. settings.json keeps them under `secrets`, each encrypted with
// Electron's safeStorage (Chromium's "v10": AES-128-CBC with a key derived from a password the macOS Keychain holds as
// "<app name> Safe Storage"); the rest of `env` (voice IDs, the direction) stays readable. So a settings file left
// behind when the app is dragged to the Trash gives nothing away, and macOS releases the Keychain password only to
// this app (a different build of it asks the user once). App menu → Uninstall deletes the Keychain entry too.
// Scripts run outside Electron (`npm run dev:server`, the smoke and bench scripts) decrypt with the same password,
// read with `security` (electron/settings.ts loadDesktopEnv); macOS asks before handing it over.
import { execFileSync } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";

/** Encrypts and decrypts one value: Electron's safeStorage in the app. Throws when it can't (Keychain access denied). */
export interface Cipher {
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

/** What settings.json holds: readable values, and the secret ones encrypted (base64). */
export interface StoredEnv {
  env?: Record<string, string>;
  secrets?: Record<string, string>;
}

/** The Keychain item safeStorage keeps its password in, for an app named `appName` (app.name). */
export const keychainService = (appName: string) => ({ service: `${appName} Safe Storage`, account: `${appName} Key` });

/**
 * `env` as settings.json stores it: the `secretKeys` encrypted under `secrets`, everything else under `env`. Blank
 * values are dropped. Without a cipher (encryption unavailable), the secrets can't be kept safely: they're dropped
 * too, and listed in `dropped` (the caller says so; they still apply for this run).
 */
export function sealEnv(env: Record<string, string>, secretKeys: readonly string[], cipher: Cipher | null): Required<StoredEnv> & { dropped: string[] } {
  const out: Required<StoredEnv> & { dropped: string[] } = { env: {}, secrets: {}, dropped: [] };
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (!secretKeys.includes(key)) out.env[key] = value;
    else if (cipher) out.secrets[key] = cipher.encrypt(value).toString("base64");
    else out.dropped.push(key);
  }
  return out;
}

/**
 * The env back in plain text. `unreadable`: secrets that couldn't be decrypted (the Keychain refused, or its entry is
 * gone): they read as not set, so Settings asks for them again. `plaintext`: secret keys still stored readable under
 * `env` (written before encryption): they're used, and the caller re-saves them encrypted.
 */
export function openEnv(stored: StoredEnv, secretKeys: readonly string[], cipher: Cipher | null): { env: Record<string, string>; unreadable: string[]; plaintext: string[] } {
  const env: Record<string, string> = {};
  const unreadable: string[] = [];
  const plaintext: string[] = [];
  for (const [key, value] of Object.entries(stored.env ?? {})) {
    if (typeof value !== "string" || !value) continue;
    env[key] = value;
    if (secretKeys.includes(key)) plaintext.push(key);
  }
  for (const [key, value] of Object.entries(stored.secrets ?? {})) {
    if (typeof value !== "string" || !value) continue;
    let text = "";
    try { text = cipher ? cipher.decrypt(Buffer.from(value, "base64")) : ""; } catch { /* denied, or another key */ }
    if (text) env[key] = text;
    else if (!env[key]) unreadable.push(key);
  }
  return { env, unreadable, plaintext };
}

/** Decrypts a safeStorage ("v10") value with the Keychain password, outside Electron. Null if it doesn't decrypt. */
export function decryptV10(data: Buffer, password: string): string | null {
  if (data.subarray(0, 3).toString("latin1") !== "v10") return null;
  try {
    const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
    return Buffer.concat([decipher.update(data.subarray(3)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** The safeStorage password from the Keychain (macOS asks the user first), or null. */
export function keychainPassword(appName: string): string | null {
  const { service, account } = keychainService(appName);
  try {
    return execFileSync("security", ["find-generic-password", "-w", "-s", service, "-a", account], {
      encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

/** A Cipher for scripts outside Electron: decrypts only (they never save), with the password read lazily, once. */
export function keychainCipher(appName: string, read = keychainPassword): Cipher {
  let password: string | null | undefined; // undefined: not asked yet (asked once, even when it fails)
  return {
    encrypt: () => { throw new Error("read-only outside the app"); },
    decrypt: (data) => {
      if (password === undefined) password = read(appName);
      const text = password ? decryptV10(data, password) : null;
      if (text === null) throw new Error("can't decrypt");
      return text;
    },
  };
}
