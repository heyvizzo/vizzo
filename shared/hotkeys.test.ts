import { describe, expect, it } from "vitest";
import { DEFAULT_HOTKEYS, endsHold, hotkeyLabel, hotkeyProblem, matchesDown, normalizeHotkeys } from "./hotkeys.ts";

const bare = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };

describe("hotkeys", () => {
  it("matches Ctrl+M exactly", () => {
    const hk = DEFAULT_HOTKEYS.comment;
    expect(matchesDown({ code: "KeyM", ...bare, ctrlKey: true }, hk)).toBe(true);
    expect(matchesDown({ code: "KeyM", ...bare }, hk)).toBe(false);
    expect(matchesDown({ code: "KeyM", ...bare, ctrlKey: true, shiftKey: true }, hk)).toBe(false);
    expect(endsHold({ code: "KeyM" }, hk)).toBe(true);
    expect(endsHold({ code: "ControlRight" }, hk)).toBe(true);
    expect(endsHold({ code: "ShiftLeft" }, hk)).toBe(false);
  });

  it("reads like macOS menus", () => {
    expect(hotkeyLabel(DEFAULT_HOTKEYS.talk)).toBe("Control");
    expect(hotkeyLabel(DEFAULT_HOTKEYS.comment)).toBe("⌃M");
    expect(hotkeyLabel({ code: "CapsLock", ctrl: false, alt: false, shift: false, meta: false })).toBe("Caps Lock");
    expect(hotkeyLabel({ code: "Space", ctrl: false, alt: true, shift: true, meta: false })).toBe("⌥⇧Space");
  });

  it("normalizes saved values", () => {
    expect(normalizeHotkeys(undefined)).toEqual(DEFAULT_HOTKEYS);
    expect(normalizeHotkeys({ talk: { code: "ShiftLeft", shift: true } }).talk).toEqual({ code: "Shift", ctrl: false, alt: false, shift: false, meta: false });
    expect(normalizeHotkeys({ talk: { code: "Escape" } }).talk).toEqual(DEFAULT_HOTKEYS.talk);
    // Both on one key: the defaults.
    expect(normalizeHotkeys({ talk: DEFAULT_HOTKEYS.comment, comment: DEFAULT_HOTKEYS.comment })).toEqual(DEFAULT_HOTKEYS);
  });

  it("flags hotkeys that can't work", () => {
    const k = (code: string, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {}) => ({ code, ctrl: false, alt: false, shift: false, meta: false, ...mods });
    expect(hotkeyProblem("talk", DEFAULT_HOTKEYS.talk, DEFAULT_HOTKEYS)).toBeNull();
    expect(hotkeyProblem("comment", DEFAULT_HOTKEYS.comment, DEFAULT_HOTKEYS)).toBeNull();
    expect(hotkeyProblem("talk", k("Shift"), DEFAULT_HOTKEYS)).toBeNull();
    expect(hotkeyProblem("talk", k("F5"), DEFAULT_HOTKEYS)).toBeNull();
    expect(hotkeyProblem("talk", DEFAULT_HOTKEYS.comment, DEFAULT_HOTKEYS)).toMatch(/already comment mode/);
    expect(hotkeyProblem("talk", k("KeyT"), DEFAULT_HOTKEYS)).toMatch(/types/);
    expect(hotkeyProblem("comment", k("KeyR", { meta: true }), DEFAULT_HOTKEYS)).toMatch(/taken/);
    expect(hotkeyProblem("comment", k("Alt"), DEFAULT_HOTKEYS)).toMatch(/needs a key/);
    expect(hotkeyProblem("comment", k("CapsLock"), DEFAULT_HOTKEYS)).toBeNull();
  });
});
