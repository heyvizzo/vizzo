import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptV10, keychainCipher, keychainService, openEnv, sealEnv, type Cipher } from "./secrets.ts";
import { loadDesktopEnv } from "./settings.ts";

const SECRET = ["OPENAI_API_KEY", "ELEVENLABS_API_KEY"];

/** A stand-in for safeStorage: "v10" + the text reversed; `deny` makes decrypt fail (the Keychain refused). */
function fakeCipher(deny = false): Cipher {
  return {
    encrypt: (text) => Buffer.from("v10" + [...text].reverse().join("")),
    decrypt: (data) => {
      if (deny) throw new Error("denied");
      return [...data.subarray(3).toString()].reverse().join("");
    },
  };
}

/** What Electron's safeStorage writes on macOS for `text` with Keychain password `password`. */
function v10(text: string, password: string): Buffer {
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const c = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  return Buffer.concat([Buffer.from("v10"), c.update(text, "utf8"), c.final()]);
}

describe("sealEnv / openEnv", () => {
  it("encrypts the API keys and keeps the rest readable; nothing secret is left in plain text", () => {
    const sealed = sealEnv({ OPENAI_API_KEY: "sk-123", ELEVENLABS_VOICE_ID: "v1", ELEVENLABS_API_KEY: "" }, SECRET, fakeCipher());
    expect(sealed.env).toEqual({ ELEVENLABS_VOICE_ID: "v1" });
    expect(Object.keys(sealed.secrets)).toEqual(["OPENAI_API_KEY"]);
    expect(JSON.stringify(sealed)).not.toContain("sk-123");
    expect(openEnv(sealed, SECRET, fakeCipher())).toEqual({ env: { ELEVENLABS_VOICE_ID: "v1", OPENAI_API_KEY: "sk-123" }, unreadable: [], plaintext: [] });
  });

  it("without encryption, doesn't save the API keys at all (and says which)", () => {
    const sealed = sealEnv({ OPENAI_API_KEY: "sk-123", ELEVENLABS_VOICE_ID: "v1" }, SECRET, null);
    expect(sealed).toEqual({ env: { ELEVENLABS_VOICE_ID: "v1" }, secrets: {}, dropped: ["OPENAI_API_KEY"] });
  });

  it("keys the Keychain won't decrypt read as not set, and are listed", () => {
    const sealed = sealEnv({ OPENAI_API_KEY: "sk-123", ELEVENLABS_VOICE_ID: "v1" }, SECRET, fakeCipher());
    expect(openEnv(sealed, SECRET, fakeCipher(true))).toEqual({ env: { ELEVENLABS_VOICE_ID: "v1" }, unreadable: ["OPENAI_API_KEY"], plaintext: [] });
    expect(openEnv(sealed, SECRET, null).unreadable).toEqual(["OPENAI_API_KEY"]);
  });

  it("finds API keys saved in plain text before encryption, so they can be re-saved encrypted", () => {
    const opened = openEnv({ env: { OPENAI_API_KEY: "sk-old", ELEVENLABS_VOICE_ID: "v1" } }, SECRET, fakeCipher());
    expect(opened).toEqual({ env: { OPENAI_API_KEY: "sk-old", ELEVENLABS_VOICE_ID: "v1" }, unreadable: [], plaintext: ["OPENAI_API_KEY"] });
  });
});

describe("decryptV10", () => {
  it("reads what safeStorage writes, given the Keychain password; null for a wrong one or another format", () => {
    const data = v10("sk-or-abc", "keychain-pw");
    expect(decryptV10(data, "keychain-pw")).toBe("sk-or-abc");
    expect(decryptV10(data, "wrong")).toBeNull();
    expect(decryptV10(Buffer.from("plain"), "keychain-pw")).toBeNull();
  });
});

describe("keychainCipher", () => {
  it("asks the Keychain once, even when it's refused", () => {
    const read = vi.fn(() => null);
    const c = keychainCipher("app", read);
    expect(() => c.decrypt(v10("a", "pw"))).toThrow();
    expect(() => c.decrypt(v10("b", "pw"))).toThrow();
    expect(read).toHaveBeenCalledTimes(1);
    const ok = keychainCipher("app", () => "pw");
    expect(ok.decrypt(v10("sk-1", "pw"))).toBe("sk-1");
  });

  it("names the entry the way Electron does", () => {
    expect(keychainService("Vizzo")).toEqual({ service: "Vizzo Safe Storage", account: "Vizzo Key" });
  });
});

describe("loadDesktopEnv (scripts outside the app)", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  const file = (json: unknown) => {
    dir = mkdtempSync(join(tmpdir(), "desktop-env-"));
    writeFileSync(join(dir, "settings.json"), JSON.stringify(json));
    return join(dir, "settings.json");
  };
  const sealed = () => ({
    env: { ELEVENLABS_VOICE_ID: "v1" },
    secrets: { OPENAI_API_KEY: v10("sk-1", "pw").toString("base64"), ELEVENLABS_API_KEY: v10("el-1", "pw").toString("base64") },
  });

  it.skipIf(process.platform !== "darwin")("decrypts the saved API keys with the Keychain password; a shell variable wins", () => {
    const target: NodeJS.ProcessEnv = { ELEVENLABS_API_KEY: "from-shell" };
    loadDesktopEnv(target, file(sealed()), keychainCipher("x", () => "pw"));
    expect(target).toMatchObject({ OPENAI_API_KEY: "sk-1", ELEVENLABS_API_KEY: "from-shell", ELEVENLABS_VOICE_ID: "v1" });
  });

  it.skipIf(process.platform !== "darwin")("doesn't touch the Keychain when the shell has every key", () => {
    const read = vi.fn(() => "pw");
    loadDesktopEnv({ OPENAI_API_KEY: "a", ELEVENLABS_API_KEY: "b" }, file(sealed()), keychainCipher("x", read));
    expect(read).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== "darwin")("refused: warns and leaves those keys unset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const target: NodeJS.ProcessEnv = {};
    loadDesktopEnv(target, file(sealed()), keychainCipher("x", () => null));
    expect(target).toEqual({ ELEVENLABS_VOICE_ID: "v1" });
    expect(warn.mock.calls[0]?.[0]).toMatch(/couldn't decrypt OPENAI_API_KEY, ELEVENLABS_API_KEY/);
    warn.mockRestore();
  });
});
