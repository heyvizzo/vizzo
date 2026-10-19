import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fullDiskAccess, fullDiskRow, keychainRow, microphoneRow } from "./permissions.ts";
import { applyEnv, sanitizeEnv } from "./settings.ts";

describe("sanitizeEnv", () => {
  it("drops unknown keys, including the old Claude provider switch", () => {
    expect(sanitizeEnv({ OPENAI_API_KEY: " sk ", PATH: "/tmp", CLAUDE_PROVIDER: "anthropic", FISH_DIRECTION: "warm" })).toEqual({
      OPENAI_API_KEY: "sk",
      FISH_DIRECTION: "warm",
    });
  });

  it("keeps the fast-tier API keys", () => {
    expect(sanitizeEnv({ CEREBRAS_API_KEY: "c", FIREWORKS_API_KEY: "f", ZAI_API_KEY: "z" })).toEqual({ CEREBRAS_API_KEY: "c", FIREWORKS_API_KEY: "f", ZAI_API_KEY: "z" });
  });
});

describe("applyEnv", () => {
  it("sets filled keys and removes a cleared one", () => {
    const target: NodeJS.ProcessEnv = { OPENAI_API_KEY: "old", OTHER: "keep" };
    applyEnv({ OPENAI_API_KEY: "", ELEVENLABS_VOICE_ID: "voice" }, target);
    expect(target.OPENAI_API_KEY).toBeUndefined();
    expect(target.ELEVENLABS_VOICE_ID).toBe("voice");
    expect(target.OTHER).toBe("keep");
  });
});

describe("permission copy", () => {
  it("offers Allow while the microphone has never been asked", () => {
    expect(microphoneRow("not-determined")).toMatchObject({ ok: false, action: { id: "allow-microphone" } });
    expect(microphoneRow("granted").ok).toBe(true);
    expect(microphoneRow("denied").action?.id).toBe("open-microphone");
  });

  it("tells the user to relaunch after Full Disk Access", () => {
    expect(fullDiskRow("denied").instruction).toMatch(/quit and reopen/);
    expect(fullDiskRow("ok").ok).toBe(true);
    expect(fullDiskRow("ok").action).toBeUndefined();
    expect(keychainRow("denied").instruction).toMatch(/Always Allow/);
    expect(keychainRow("denied").action?.id).toBe("allow-keychain");
    expect(keychainRow("missing").ok).toBe(false);
    expect(keychainRow("missing").action).toBeUndefined();
    expect(keychainRow("denied").optional && keychainRow("missing").optional).toBe(true);
    expect(fullDiskRow("denied").optional).toBeUndefined();
  });
});

describe("fullDiskAccess", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it("is allowed when the Safari cookie file can be opened", () => {
    const home = mkdtempSync(join(tmpdir(), "perm-"));
    homes.push(home);
    const dir = join(home, "Library/Cookies");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Cookies.binarycookies"), "cook");
    expect(fullDiskAccess(home)).toBe("ok");
  });

  it("is missing when neither cookie file exists", () => {
    const home = mkdtempSync(join(tmpdir(), "perm-"));
    homes.push(home);
    expect(fullDiskAccess(home)).toBe("missing");
  });
});
