import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { parseSafariCookies, readBrowserCookies, toElectronCookie, type StoredCookie } from "./cookies.ts";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "cookie-home-"));
  homes.push(home);
  return home;
}

/** Chrome's macOS scheme: PBKDF2 (saltysalt, 1003) and AES-128-CBC with an IV of 16 spaces, tagged v10. */
function encryptChrome(password: string, host: string, value: string, withHash: boolean): Buffer {
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const body = withHash ? Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value)]) : Buffer.from(value);
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  return Buffer.concat([Buffer.from("v10"), cipher.update(body), cipher.final()]);
}

function futureUnix(): number {
  return Math.floor(Date.now() / 1000) + 86_400;
}

function chromeDb(path: string, rows: { host: string; name: string; value: string; encrypted: Buffer; expires: number; secure: number; httpOnly: number; sameSite: number; hasExpires: number }[]) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE cookies (
    host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
    expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, has_expires INTEGER,
    last_update_utc INTEGER
  )`);
  const insert = db.prepare(`INSERT INTO cookies
    (host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, has_expires, last_update_utc)
    VALUES (?, ?, '', ?, '/', ?, ?, ?, ?, ?, ?)`);
  rows.forEach((row, i) => insert.run(row.host, row.name, row.encrypted, row.expires, row.secure, row.httpOnly, row.sameSite, row.hasExpires, i));
  db.close();
}

describe("toElectronCookie", () => {
  const now = 1_700_000_000;
  const base: StoredCookie = {
    name: "sid", value: "abc", host: ".example.com", path: "/account", secure: true, httpOnly: true,
    expiration: now + 100, sameSite: "lax",
  };

  it("keeps a leading dot as a domain cookie", () => {
    expect(toElectronCookie(base, now)).toEqual({
      url: "https://example.com/account",
      name: "sid",
      value: "abc",
      domain: "example.com",
      path: "/account",
      secure: true,
      httpOnly: true,
      expirationDate: now + 100,
      sameSite: "lax",
    });
  });

  it("leaves a host-only cookie without a domain", () => {
    const cookie = toElectronCookie({ ...base, host: "www.example.com", secure: false, sameSite: "strict" }, now);
    expect(cookie?.domain).toBeUndefined();
    expect(cookie?.url).toBe("http://www.example.com/account");
  });

  it("forces __Host- cookies onto https, path /, and no domain", () => {
    const cookie = toElectronCookie({ ...base, name: "__Host-sid", secure: false, path: "/account" }, now);
    expect(cookie).toMatchObject({ url: "https://example.com/", path: "/", secure: true });
    expect(cookie?.domain).toBeUndefined();
  });

  it("downgrades SameSite=None when the cookie is not Secure", () => {
    expect(toElectronCookie({ ...base, secure: false, sameSite: "no_restriction" }, now)?.sameSite).toBe("lax");
  });

  it("drops an expired cookie", () => {
    expect(toElectronCookie({ ...base, expiration: now - 1 }, now)).toBeNull();
  });

  it("omits the expiry of a session cookie", () => {
    expect(toElectronCookie({ ...base, expiration: undefined }, now)?.expirationDate).toBeUndefined();
  });
});

describe("readBrowserCookies", () => {
  it("decrypts Chrome cookies, including the host hash Chrome 130 prepends", async () => {
    const home = tempHome();
    const dir = join(home, "Library/Application Support/Google/Chrome/Default/Network");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(home, "Library/Application Support/Google/Chrome/Local State"), JSON.stringify({ profile: { last_used: "Default" } }));
    const unix = futureUnix();
    const expires = (unix + 11_644_473_600) * 1_000_000;
    chromeDb(join(dir, "Cookies"), [
      { host: ".example.com", name: "sid", value: "hashed", encrypted: encryptChrome("secret", ".example.com", "hashed", true), expires, secure: 1, httpOnly: 1, sameSite: 1, hasExpires: 1 },
      { host: "plain.example", name: "old", value: "legacy", encrypted: encryptChrome("secret", "plain.example", "legacy", false), expires, secure: 0, httpOnly: 0, sameSite: -1, hasExpires: 0 },
    ]);
    // The second row has a plaintext value column, so the reader uses that and ignores the ciphertext.
    const db = new DatabaseSync(join(dir, "Cookies"));
    db.prepare("UPDATE cookies SET value = ? WHERE name = ?").run("from-column", "old");
    db.close();

    const cookies = await readBrowserCookies("chrome", { home, chromePassword: "secret" });
    const sid = cookies.find((cookie) => cookie.name === "sid");
    const old = cookies.find((cookie) => cookie.name === "old");
    expect(sid).toMatchObject({ value: "hashed", host: ".example.com", secure: true, httpOnly: true, sameSite: "lax" });
    expect(sid?.expiration).toBeGreaterThan(unix - 2);
    expect(old).toMatchObject({ value: "from-column", expiration: undefined, sameSite: "lax" });
  });

  it("reads the legacy Chrome cookie path when Network/Cookies is absent", async () => {
    const home = tempHome();
    const dir = join(home, "Library/Application Support/Google/Chrome/Profile 1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(home, "Library/Application Support/Google/Chrome/Local State"), JSON.stringify({ profile: { last_active_profiles: ["Profile 1"] } }));
    chromeDb(join(dir, "Cookies"), [
      { host: "example.com", name: "a", value: "one", encrypted: encryptChrome("secret", "example.com", "one", true), expires: 0, secure: 1, httpOnly: 0, sameSite: 2, hasExpires: 0 },
    ]);
    const cookies = await readBrowserCookies("chrome", { home, chromePassword: "secret" });
    expect(cookies).toMatchObject([{ name: "a", value: "one", sameSite: "strict" }]);
  });

  it("refuses a Chrome database the password cannot decrypt", async () => {
    const home = tempHome();
    const dir = join(home, "Library/Application Support/Google/Chrome/Default");
    mkdirSync(dir, { recursive: true });
    chromeDb(join(dir, "Cookies"), [
      { host: ".example.com", name: "sid", value: "x", encrypted: encryptChrome("right", ".example.com", "x", true), expires: 0, secure: 1, httpOnly: 0, sameSite: 1, hasExpires: 0 },
    ]);
    await expect(readBrowserCookies("chrome", { home, chromePassword: "wrong" })).rejects.toThrow(/could not be decrypted/);
  });

  it("says when Chrome is not installed", async () => {
    await expect(readBrowserCookies("chrome", { home: tempHome(), chromePassword: "x" })).rejects.toThrow(/not installed/);
  });

  it("parses a Safari binary cookie file", async () => {
    const home = tempHome();
    const dir = join(home, "Library/Containers/com.apple.Safari/Data/Library/Cookies");
    mkdirSync(dir, { recursive: true });
    const expiry = futureUnix();
    writeFileSync(join(dir, "Cookies.binarycookies"), safariFile([
      { host: ".example.com", name: "sid", path: "/", value: "abc", flags: 0x5, expiry },
    ]));
    const cookies = await readBrowserCookies("safari", { home });
    expect(cookies).toMatchObject([{ name: "sid", value: "abc", host: ".example.com", secure: true, httpOnly: true, path: "/" }]);
    expect(cookies[0]?.expiration).toBeCloseTo(expiry, 0);
  });

  it("says when Safari's cookie file is missing", async () => {
    await expect(readBrowserCookies("safari", { home: tempHome() })).rejects.toThrow(/no saved cookies/);
  });

  it("reads the default Firefox profile", async () => {
    const home = tempHome();
    const root = join(home, "Library/Application Support/Firefox");
    const profile = join(root, "abc.default-release");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(root, "profiles.ini"), "[Install1]\nDefault=abc.default-release\n\n[Profile0]\nPath=other\n");
    const db = new DatabaseSync(join(profile, "cookies.sqlite"));
    db.exec(`CREATE TABLE moz_cookies (
      host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER, lastAccessed INTEGER
    )`);
    db.prepare("INSERT INTO moz_cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(".example.com", "sid", "abc", "/", futureUnix(), 1, 1, 0, 1);
    db.close();
    const cookies = await readBrowserCookies("firefox", { home });
    expect(cookies).toMatchObject([{ name: "sid", value: "abc", host: ".example.com", secure: true, httpOnly: true, sameSite: "no_restriction" }]);
  });

  it("says when Firefox is not installed", async () => {
    await expect(readBrowserCookies("firefox", { home: tempHome() })).rejects.toThrow(/not installed/);
  });
});

describe("parseSafariCookies", () => {
  it("rejects a file that is not a cookie store", () => {
    expect(() => parseSafariCookies(Buffer.from("nope"))).toThrow(/could not be read/);
  });
});

function safariFile(cookies: { host: string; name: string; path: string; value: string; flags: number; expiry: number }[]): Buffer {
  const records = cookies.map((cookie) => {
    const fields = [cookie.host, cookie.name, cookie.path, cookie.value].map((text) => Buffer.from(`${text}\0`));
    const header = 56;
    const size = header + fields.reduce((sum, field) => sum + field.length, 0);
    const record = Buffer.alloc(size);
    record.writeUInt32LE(size, 0);
    record.writeUInt32LE(cookie.flags, 8);
    let at = header;
    const offsets = fields.map((field) => {
      const offset = at;
      field.copy(record, at);
      at += field.length;
      return offset;
    });
    record.writeUInt32LE(offsets[0] ?? 0, 16);
    record.writeUInt32LE(offsets[1] ?? 0, 20);
    record.writeUInt32LE(offsets[2] ?? 0, 24);
    record.writeUInt32LE(offsets[3] ?? 0, 28);
    record.writeDoubleLE(cookie.expiry - 978_307_200, 40);
    record.writeDoubleLE(cookie.expiry - 978_307_200 - 10, 48);
    return record;
  });
  const count = records.length;
  const headerLen = 8 + 4 * count;
  const pageSize = headerLen + records.reduce((sum, record) => sum + record.length, 0);
  const page = Buffer.alloc(pageSize);
  page.writeUInt32LE(0x00000100, 0);
  page.writeUInt32LE(count, 4);
  let recordAt = headerLen;
  records.forEach((record, index) => {
    page.writeUInt32LE(recordAt, 8 + index * 4);
    record.copy(page, recordAt);
    recordAt += record.length;
  });
  const file = Buffer.alloc(12 + pageSize + 8);
  file.write("cook", 0);
  file.writeUInt32BE(1, 4);
  file.writeUInt32BE(pageSize, 8);
  page.copy(file, 12);
  return file;
}
