import { describe, expect, it, vi } from "vitest";
import { legacySecrets, moveLegacyDir, type DirFs } from "./rename.ts";
import type { Cipher } from "./secrets.ts";

const fakeFs = (dirs: Record<string, string[]>): DirFs & { moves: string[] } => {
  const moves: string[] = [];
  return {
    moves,
    exists: (p) => p in dirs,
    isEmpty: (p) => dirs[p]!.length === 0,
    move: (from, to) => { moves.push(`${from} → ${to}`); dirs[to] = dirs[from]!; delete dirs[from]; },
  };
};

describe("moveLegacyDir", () => {
  it("moves the old folder over a missing or empty new one", () => {
    const missing = fakeFs({ "/old": ["settings.json"] });
    expect(moveLegacyDir("/old", "/new", missing)).toBe(true);
    const empty = fakeFs({ "/old": ["settings.json"], "/new": [] });
    expect(moveLegacyDir("/old", "/new", empty)).toBe(true);
    expect(empty.moves).toEqual(["/old → /new"]);
  });
  it("leaves both alone once the new one has anything in it, or there's no old one", () => {
    const used = fakeFs({ "/old": ["settings.json"], "/new": ["settings.json"] });
    expect(moveLegacyDir("/old", "/new", used)).toBe(false);
    expect(moveLegacyDir("/old", "/new", fakeFs({ "/new": [] }))).toBe(false);
  });
});

describe("legacySecrets", () => {
  const plain: Cipher = { encrypt: () => Buffer.from(""), decrypt: (d) => d.toString("utf8") };
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  it("decrypts the unreadable keys with the old name's password and forgets the old entry", () => {
    const forget = vi.fn();
    const stored = { secrets: { OPENAI_API_KEY: b64("sk-1"), ANTHROPIC_API_KEY: b64("sk-2") } };
    expect(legacySecrets(stored, ["OPENAI_API_KEY"], ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"], "Old", plain, forget)).toEqual({ OPENAI_API_KEY: "sk-1" });
    expect(forget).toHaveBeenCalledWith("Old");
  });
  it("keeps the old entry when it can't decrypt", () => {
    const forget = vi.fn();
    const denied: Cipher = { encrypt: () => Buffer.from(""), decrypt: () => { throw new Error("denied"); } };
    expect(legacySecrets({ secrets: { OPENAI_API_KEY: b64("x") } }, ["OPENAI_API_KEY"], ["OPENAI_API_KEY"], "Old", denied, forget)).toEqual({});
    expect(forget).not.toHaveBeenCalled();
  });
});
