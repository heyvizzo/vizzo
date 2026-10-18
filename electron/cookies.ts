// Reads cookies from the user's other browsers so the pane can open sites already signed in.
// Chrome encrypts each value (macOS Keychain password → AES-128-CBC). Safari uses a binary file that
// needs Full Disk Access. Firefox stores them in SQLite. macOS only.
import { execFile } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type BrowserId = "chrome" | "safari" | "firefox";
export type SameSite = "no_restriction" | "lax" | "strict";

export interface StoredCookie {
  name: string;
  value: string;
  /** A leading dot means the cookie is sent to subdomains. */
  host: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Unix seconds. Absent for a session cookie. */
  expiration?: number;
  sameSite: SameSite;
}

/** What `session.cookies.set` takes. Kept here so this file does not import Electron. */
export interface ElectronCookie {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
  sameSite: SameSite;
}

export class CookieReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CookieReadError";
  }
}

export interface ReadOptions {
  /** Home directory. Tests pass a fixture; the app uses the real one. */
  home?: string;
  /** Tests pass this instead of reading the macOS Keychain. */
  chromePassword?: string;
}

const LABELS: Record<BrowserId, string> = { chrome: "Chrome", safari: "Safari", firefox: "Firefox" };

/** Seconds between 1601-01-01 (Chrome) and 1970-01-01. */
const CHROME_EPOCH = 11_644_473_600;
/** Seconds between 1970-01-01 and 2001-01-01 (Safari). */
const SAFARI_EPOCH = 978_307_200;

function label(browser: BrowserId): string {
  return LABELS[browser];
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

function isPermission(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES";
}

function isDir(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/** The newest of the files that exist. */
function newestFile(paths: string[]): string | null {
  const found = paths.filter(isFile);
  found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return found[0] ?? null;
}

function asBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.alloc(0);
}

function asNumber(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "string" && value) return Number(value);
  return 0;
}

/** Chrome's expires_utc is microseconds since 1601 and does not fit in a JS number. */
function chromeExpiry(expiresUtc: unknown, hasExpires: unknown): number | undefined {
  if (asNumber(hasExpires) === 0) return undefined;
  let micro: bigint;
  if (typeof expiresUtc === "bigint") micro = expiresUtc;
  else if (typeof expiresUtc === "number" && Number.isFinite(expiresUtc)) micro = BigInt(Math.trunc(expiresUtc));
  else return undefined;
  if (micro <= 0n) return undefined;
  return Number(micro / 1_000_000n - BigInt(CHROME_EPOCH));
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A cookie the pane can store. Drops expired cookies and ones Chromium would reject.
 * `__Host-` cookies are host-only, Secure, and path `/`. SameSite=None requires Secure.
 */
export function toElectronCookie(cookie: StoredCookie, nowSec: number): ElectronCookie | null {
  const name = cookie.name.trim();
  if (!name || /[\s;,]/.test(name)) return null;
  const host = cookie.host.trim().toLowerCase();
  if (!host || /[\s/;,]/.test(host)) return null;
  const domainCookie = host.startsWith(".");
  const bare = host.replace(/^\./, "");
  if (!bare || bare.startsWith(".")) return null;

  let path = cookie.path?.startsWith("/") ? cookie.path : "/";
  let secure = cookie.secure;
  const hostOnly = name.startsWith("__Host-");
  if (hostOnly) {
    secure = true;
    path = "/";
  } else if (name.startsWith("__Secure-")) {
    secure = true;
  }
  let sameSite = cookie.sameSite;
  if (sameSite === "no_restriction" && !secure) sameSite = "lax";

  let expiration: number | undefined;
  if (cookie.expiration !== undefined) {
    if (!Number.isFinite(cookie.expiration) || cookie.expiration <= nowSec) return null;
    expiration = cookie.expiration;
  }

  const url = `${secure ? "https" : "http"}://${bare}${path}`;
  try {
    void new URL(url);
  } catch {
    return null;
  }
  const details: ElectronCookie = { url, name, value: cookie.value, path, secure, httpOnly: cookie.httpOnly, sameSite };
  if (domainCookie && !hostOnly) details.domain = bare;
  if (expiration !== undefined) details.expirationDate = expiration;
  return details;
}

// ── Chrome ──

/** Decrypt a `v10` value. Chrome 130+ (DB version ≥ 24) prefixes the plaintext with SHA-256(host). */
export function decryptChromeValue(encrypted: Buffer, key: Buffer, hostKey: string): string | null {
  if (encrypted.length < 3) return null;
  const tag = encrypted.subarray(0, 3).toString("latin1");
  if (tag !== "v10" && tag !== "v11") return null;
  const data = encrypted.subarray(3);
  if (data.length === 0 || data.length % 16 !== 0) return null;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    const hash = createHash("sha256").update(hostKey).digest();
    const body = plain.length >= hash.length && plain.subarray(0, hash.length).equals(hash) ? plain.subarray(hash.length) : plain;
    return body.toString("utf8");
  } catch {
    return null;
  }
}

function chromeKey(password: string): Buffer {
  return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

function chromeSameSite(value: number): SameSite {
  if (value === 0) return "no_restriction";
  if (value === 2) return "strict";
  return "lax";
}

function cookieFromChromeRow(row: Record<string, unknown>, key: Buffer): StoredCookie | null {
  const host = asString(row.host_key);
  const name = asString(row.name);
  if (!host || !name) return null;
  const plain = asString(row.value);
  const value = plain ? plain : decryptChromeValue(asBuffer(row.encrypted_value), key, host);
  if (value === null) return null;
  const expiration = chromeExpiry(row.expires_utc, row.has_expires);
  return {
    name,
    value,
    host,
    path: asString(row.path) || "/",
    secure: asNumber(row.is_secure) === 1,
    httpOnly: asNumber(row.is_httponly) === 1,
    expiration,
    sameSite: chromeSameSite(asNumber(row.samesite)),
  };
}

/** Opens a copy of a SQLite file so a running browser's lock does not block the read. */
function readCopiedDatabase(src: string, queries: string[]): Record<string, unknown>[] {
  const dir = mkdtempSync(join(tmpdir(), "cookie-import-"));
  const dest = join(dir, "cookies.db");
  try {
    copyFileSync(src, dest);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        copyFileSync(src + suffix, dest + suffix);
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
    }
    // Chrome timestamps are bigger than a JS number, so integers come back as bigint.
    const db = new DatabaseSync(dest, { readOnly: true, timeout: 2000, readBigInts: true });
    try {
      let last: unknown;
      for (const sql of queries) {
        try {
          return db.prepare(sql).all() as Record<string, unknown>[];
        } catch (err) {
          last = err;
        }
      }
      throw last instanceof Error ? last : new Error("could not query the cookie database");
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CHROME_QUERIES = [
  `SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, has_expires
   FROM cookies ORDER BY last_update_utc`,
  `SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, has_expires
   FROM cookies`,
  `SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, 1 AS samesite, has_expires
   FROM cookies`,
];

function chromeCookieDb(profileDir: string): string | null {
  return newestFile([join(profileDir, "Network", "Cookies"), join(profileDir, "Cookies")]);
}

function chromeProfileDir(userData: string): string | null {
  const names: string[] = [];
  try {
    const state = JSON.parse(readFileSync(join(userData, "Local State"), "utf8")) as {
      profile?: { last_used?: unknown; last_active_profiles?: unknown; profiles_order?: unknown };
    };
    const profile = state.profile ?? {};
    const listed = [
      profile.last_used,
      ...(Array.isArray(profile.last_active_profiles) ? profile.last_active_profiles : []),
      ...(Array.isArray(profile.profiles_order) ? profile.profiles_order : []),
    ];
    for (const value of listed) {
      if (typeof value === "string" && value && !names.includes(value)) names.push(value);
    }
  } catch {
    // No Local State: fall through to Default and any Profile directory.
  }
  if (!names.includes("Default")) names.push("Default");
  for (const name of names) {
    const dir = join(userData, name);
    if (isDir(dir) && chromeCookieDb(dir)) return dir;
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(userData);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (name !== "Default" && !/^Profile \d+$/.test(name)) continue;
    const dir = join(userData, name);
    if (isDir(dir) && chromeCookieDb(dir)) return dir;
  }
  return null;
}

async function chromeSafeStoragePassword(): Promise<string> {
  const attempts = [
    ["find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"],
    ["find-generic-password", "-w", "-s", "Chrome Safe Storage"],
  ];
  let last: unknown;
  for (const args of attempts) {
    try {
      const { stdout } = await execFileAsync("/usr/bin/security", args, { encoding: "utf8", timeout: 120_000 });
      const password = stdout.replace(/\r?\n$/, "");
      if (password) return password;
    } catch (err) {
      last = err;
    }
  }
  void last;
  throw new CookieReadError("macOS did not allow access to Chrome’s “Chrome Safe Storage” key. Allow the Keychain prompt and try again.");
}

async function readChrome(home: string, password?: string): Promise<StoredCookie[]> {
  const userData = join(home, "Library/Application Support/Google/Chrome");
  if (!isDir(userData)) throw new CookieReadError("Chrome is not installed.");
  const profile = chromeProfileDir(userData);
  const dbPath = profile ? chromeCookieDb(profile) : null;
  if (!dbPath) throw new CookieReadError("Chrome has no saved cookies.");
  const secret = password ?? (await chromeSafeStoragePassword());
  const key = chromeKey(secret);
  let rows: Record<string, unknown>[];
  try {
    rows = readCopiedDatabase(dbPath, CHROME_QUERIES);
  } catch (err) {
    if (err instanceof CookieReadError) throw err;
    if (isPermission(err)) throw new CookieReadError("Chrome’s cookie database is not readable.");
    throw new CookieReadError("Could not read Chrome’s cookie database. Quit Chrome and try again.");
  }
  const cookies: StoredCookie[] = [];
  let encrypted = 0;
  let decrypted = 0;
  for (const row of rows) {
    const blob = asBuffer(row.encrypted_value);
    const hadCipher = !asString(row.value) && blob.length > 0;
    if (hadCipher) encrypted += 1;
    const cookie = cookieFromChromeRow(row, key);
    if (!cookie) continue;
    if (hadCipher) decrypted += 1;
    cookies.push(cookie);
  }
  // A wrong key passes the padding check about 1 time in 256, so a thin yield is not a real import.
  if (encrypted > 0 && decrypted * 2 < encrypted) {
    throw new CookieReadError("Chrome’s cookies could not be decrypted. Allow Keychain access for “Chrome Safe Storage” and try again.");
  }
  return cookies;
}

// ── Safari ──

function cstring(record: Buffer, offset: number): string | null {
  if (!Number.isInteger(offset) || offset <= 0 || offset >= record.length) return null;
  const end = record.indexOf(0, offset);
  return record.subarray(offset, end === -1 ? record.length : end).toString("utf8");
}

/** One `Cookies.binarycookies` file: big-endian page table, little-endian records, Mac absolute timestamps. */
export function parseSafariCookies(data: Buffer): StoredCookie[] {
  if (data.length < 8 || data.subarray(0, 4).toString("latin1") !== "cook") {
    throw new CookieReadError("Safari’s cookie file could not be read.");
  }
  const pageCount = data.readUInt32BE(4);
  if (pageCount > 10_000 || 8 + pageCount * 4 > data.length) {
    throw new CookieReadError("Safari’s cookie file could not be read.");
  }
  let cursor = 8;
  const sizes: number[] = [];
  for (let i = 0; i < pageCount; i += 1) {
    sizes.push(data.readUInt32BE(cursor));
    cursor += 4;
  }
  const cookies: StoredCookie[] = [];
  for (const size of sizes) {
    if (size < 8 || cursor + size > data.length) break;
    const page = data.subarray(cursor, cursor + size);
    cursor += size;
    const count = page.readUInt32LE(4);
    if (count > 100_000 || 8 + count * 4 > page.length) continue;
    for (let i = 0; i < count; i += 1) {
      const recordAt = page.readUInt32LE(8 + i * 4);
      if (recordAt < 0 || recordAt + 56 > page.length) continue;
      const recordSize = page.readUInt32LE(recordAt);
      if (recordSize < 56 || recordAt + recordSize > page.length) continue;
      const record = page.subarray(recordAt, recordAt + recordSize);
      const name = cstring(record, record.readUInt32LE(20));
      const host = cstring(record, record.readUInt32LE(16));
      if (!name || !host) continue;
      const flags = record.readUInt32LE(8);
      const mac = record.readDoubleLE(40);
      const unix = mac + SAFARI_EPOCH;
      cookies.push({
        name,
        value: cstring(record, record.readUInt32LE(28)) ?? "",
        host,
        path: cstring(record, record.readUInt32LE(24)) || "/",
        secure: (flags & 0x1) !== 0,
        httpOnly: (flags & 0x4) !== 0,
        expiration: Number.isFinite(mac) && mac > 0 ? unix : undefined,
        sameSite: "lax",
      });
    }
  }
  return cookies;
}

function safariCookieFiles(home: string): string[] {
  const paths = [join(home, "Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies")];
  const store = join(home, "Library/Containers/com.apple.Safari/Data/Library/WebKit/WebsiteDataStore");
  if (isDir(store)) {
    let ids: string[] = [];
    try {
      ids = readdirSync(store);
    } catch {
      ids = [];
    }
    const profiles = ids
      .map((id) => join(store, id, "Cookies", "Cookies.binarycookies"))
      .filter(isFile);
    profiles.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    paths.push(...profiles);
  }
  paths.push(join(home, "Library/Cookies/Cookies.binarycookies"));
  return paths.filter(isFile);
}

function readSafari(home: string): StoredCookie[] {
  const files = safariCookieFiles(home);
  if (!files.length) throw new CookieReadError("Safari has no saved cookies.");
  // The first existing file is the live store. A permission error there is Full Disk Access, not a reason to try a stale copy.
  try {
    return parseSafariCookies(readFileSync(files[0]!));
  } catch (err) {
    if (err instanceof CookieReadError) throw err;
    if (isPermission(err)) {
      throw new CookieReadError("Safari’s cookies are not readable. Grant Full Disk Access to the app that launched this window (System Settings → Privacy & Security → Full Disk Access), then try again.");
    }
    throw new CookieReadError("Safari’s cookie file could not be read.");
  }
}

// ── Firefox ──

interface IniSection { name: string; entries: Record<string, string> }

function parseIni(text: string): IniSection[] {
  const sections: IniSection[] = [];
  let current: IniSection | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.+)]$/.exec(line);
    if (header?.[1]) {
      current = { name: header[1], entries: {} };
      sections.push(current);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq > 0 && current) current.entries[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return sections;
}

function firefoxProfileDir(home: string): string {
  const root = join(home, "Library/Application Support/Firefox");
  const iniPath = join(root, "profiles.ini");
  if (!isFile(iniPath)) throw new CookieReadError("Firefox is not installed.");
  let text: string;
  try {
    text = readFileSync(iniPath, "utf8");
  } catch (err) {
    if (isPermission(err)) throw new CookieReadError("Firefox’s profile list is not readable.");
    throw new CookieReadError("Firefox is not installed.");
  }
  const sections = parseIni(text);
  const install = sections.find((section) => section.name.startsWith("Install") && section.entries.Default);
  const marked = sections.find((section) => section.name.startsWith("Profile") && section.entries.Default === "1" && section.entries.Path);
  const first = sections.find((section) => section.name.startsWith("Profile") && section.entries.Path);
  const chosen = install ?? marked ?? first;
  if (!chosen) throw new CookieReadError("Firefox has no profile.");
  const relative = chosen.entries.IsRelative !== "0";
  const path = chosen.entries.Default ?? chosen.entries.Path ?? "";
  const dir = !relative && chosen.entries.Path ? chosen.entries.Path : join(root, path);
  if (!isDir(dir)) throw new CookieReadError("Firefox has no profile.");
  return dir;
}

function firefoxSameSite(value: number): SameSite {
  if (value === 0) return "no_restriction";
  if (value === 2) return "strict";
  return "lax";
}

function cookieFromFirefoxRow(row: Record<string, unknown>): StoredCookie | null {
  const host = asString(row.host);
  const name = asString(row.name);
  if (!host || !name) return null;
  const expiry = asNumber(row.expiry);
  return {
    name,
    value: asString(row.value),
    host,
    path: asString(row.path) || "/",
    secure: asNumber(row.isSecure) === 1,
    httpOnly: asNumber(row.isHttpOnly) === 1,
    expiration: expiry > 0 ? expiry : undefined,
    sameSite: firefoxSameSite(asNumber(row.sameSite)),
  };
}

const FIREFOX_QUERIES = [
  `SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies ORDER BY lastAccessed`,
  `SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies`,
  `SELECT host, name, value, path, expiry, isSecure, isHttpOnly, 1 AS sameSite FROM moz_cookies`,
];

function readFirefox(home: string): StoredCookie[] {
  const dir = firefoxProfileDir(home);
  const dbPath = join(dir, "cookies.sqlite");
  if (!isFile(dbPath)) throw new CookieReadError("Firefox has no saved cookies.");
  let rows: Record<string, unknown>[];
  try {
    rows = readCopiedDatabase(dbPath, FIREFOX_QUERIES);
  } catch (err) {
    if (err instanceof CookieReadError) throw err;
    if (isPermission(err)) throw new CookieReadError("Firefox’s cookie database is not readable.");
    throw new CookieReadError("Could not read Firefox’s cookie database. Quit Firefox and try again.");
  }
  return rows.map(cookieFromFirefoxRow).filter((cookie): cookie is StoredCookie => cookie !== null);
}

export async function readBrowserCookies(browser: BrowserId, options: ReadOptions = {}): Promise<StoredCookie[]> {
  if (process.platform !== "darwin") throw new CookieReadError(`Importing ${label(browser)} cookies is supported on macOS.`);
  const home = options.home ?? process.env.HOME ?? "";
  if (!home) throw new CookieReadError(`Could not find the home directory to read ${label(browser)} cookies.`);
  if (browser === "chrome") return readChrome(home, options.chromePassword);
  if (browser === "safari") return readSafari(home);
  return readFirefox(home);
}
