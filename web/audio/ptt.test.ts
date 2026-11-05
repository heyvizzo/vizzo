import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HOTKEYS, TALK_HOLD_MS, setHotkeys } from "../../shared/hotkeys.ts";
import { createTalkKey, isPttKey, isPttKeyUp, isTextInputType } from "./ptt.ts";

const bare = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
const key = (code: string, mods: Partial<typeof bare> = {}, repeat = false) => ({ code, ...bare, ...mods, repeat }) as KeyboardEvent;

describe("push-to-talk key", () => {
  afterEach(() => setHotkeys(DEFAULT_HOTKEYS));

  it("is a lone Control by default, either side", () => {
    expect(isPttKey(key("ControlLeft", { ctrlKey: true }))).toBe(true);
    expect(isPttKey(key("ControlRight", { ctrlKey: true }))).toBe(true);
    expect(isPttKey(key("ControlLeft", { ctrlKey: true, metaKey: true }))).toBe(false);
    expect(isPttKey(key("ShiftLeft", { shiftKey: true }))).toBe(false);
    expect(isPttKeyUp(key("ControlLeft"))).toBe(true);
  });

  it("follows the saved hotkey", () => {
    setHotkeys({ ...DEFAULT_HOTKEYS, talk: { code: "Shift", ctrl: false, alt: false, shift: false, meta: false } });
    expect(isPttKey(key("ShiftLeft", { shiftKey: true }))).toBe(true);
    expect(isPttKey(key("ControlLeft", { ctrlKey: true }))).toBe(false);
  });

  it("treats checkboxes, radios and sliders as not typing", () => {
    expect(isTextInputType("checkbox")).toBe(false);
    expect(isTextInputType("radio")).toBe(false);
    expect(isTextInputType("range")).toBe(false);
    expect(isTextInputType("button")).toBe(false);
    expect(isTextInputType("text")).toBe(true);
    expect(isTextInputType("search")).toBe(true);
    expect(isTextInputType("number")).toBe(true);
    expect(isTextInputType("")).toBe(true);
  });
});

describe("createTalkKey", () => {
  afterEach(() => { vi.useRealTimers(); setHotkeys(DEFAULT_HOTKEYS); });

  it("talks once a modifier is held alone, and stops on release", () => {
    vi.useFakeTimers();
    const seen: boolean[] = [];
    const talk = createTalkKey((d) => seen.push(d));
    talk.keydown(key("ControlLeft", { ctrlKey: true }), true);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(TALK_HOLD_MS);
    expect(seen).toEqual([true]);
    talk.keyup(key("ControlLeft"));
    expect(seen).toEqual([true, false]);
  });

  it("doesn't talk for a shortcut or a modifier-click", () => {
    vi.useFakeTimers();
    const seen: boolean[] = [];
    const talk = createTalkKey((d) => seen.push(d));
    talk.keydown(key("ControlLeft", { ctrlKey: true }), true);
    talk.keydown(key("KeyM", { ctrlKey: true }), true);
    vi.advanceTimersByTime(TALK_HOLD_MS * 2);
    talk.keyup(key("ControlLeft"));
    talk.keydown(key("ControlLeft", { ctrlKey: true }), true);
    talk.pointerdown();
    vi.advanceTimersByTime(TALK_HOLD_MS * 2);
    expect(seen).toEqual([]);
  });

  it("talks at once for a key with modifiers, and not while typing", () => {
    setHotkeys({ ...DEFAULT_HOTKEYS, talk: { code: "Space", ctrl: false, alt: true, shift: false, meta: false } });
    const seen: boolean[] = [];
    const talk = createTalkKey((d) => seen.push(d));
    talk.keydown(key("Space", { altKey: true }), false);
    expect(seen).toEqual([]);
    talk.keydown(key("Space", { altKey: true }), true);
    expect(seen).toEqual([true]);
    talk.keyup(key("AltLeft"));
    expect(seen).toEqual([true, false]);
  });
});
