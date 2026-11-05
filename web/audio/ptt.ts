// Push-to-talk: hold the talk key (Control by default, Settings → Keyboard; outside inputs) or hold the given button.
import { TALK_HOLD_MS, endsHold, hotkeys, isModifierCode, matchesDown, type KeyLike } from "../../shared/hotkeys.ts";

export interface PttOpts {
  button?: HTMLElement;
  onPress: () => void;
  onRelease: () => void;
  /** Another source of presses, e.g. the talk key held in the Electron app's browser pane (relayed over IPC). */
  external?: (press: () => void, release: () => void) => void;
}

/** Input types that are not text entry, so the talk key stays free for push-to-talk. */
const NOT_TEXT_INPUT = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);

/** True for text-like input types (including the default empty type). Checkboxes and sliders are false. */
export function isTextInputType(type: string): boolean {
  return !NOT_TEXT_INPUT.has(type);
}

/** True if keyboard focus is in a text-entry control, where keys are for typing. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return isTextInputType(el.type);
  return false;
}

/** The talk key going down, with exactly its modifiers (so shortcuts like Cmd+Ctrl+… don't start a turn). */
export function isPttKey(e: KeyLike): boolean {
  return matchesDown(e, hotkeys().talk);
}

/** The key coming up ends a talk-key hold (the key, or one of its modifiers). */
export function isPttKeyUp(e: { code: string }): boolean {
  return endsHold(e, hotkeys().talk);
}

export interface TalkKey {
  /** `allowed`: not typing (checked only when the talk key goes down). */
  keydown(e: KeyboardEvent, allowed: boolean): void;
  keyup(e: KeyboardEvent): void;
  /** A click while a modifier is pending makes it a modifier-click, not talking. */
  pointerdown(): void;
  /** Let go (window blur, page hide). */
  release(): void;
}

/**
 * The talk key's presses and releases. A key with its modifiers talks at once; a modifier alone once it's held holdMs
 * with no other key or click in the meantime (Ctrl+M and Ctrl-click are shortcuts, not talking). Auto-repeat is ignored.
 */
export function createTalkKey(onChange: (down: boolean) => void, holdMs = TALK_HOLD_MS): TalkKey {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let down = false;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const press = () => {
    timer = null;
    if (down) return;
    down = true;
    onChange(true);
  };
  const release = () => {
    cancel();
    if (!down) return;
    down = false;
    onChange(false);
  };
  return {
    keydown(e, allowed) {
      if (e.repeat) return;
      if (!isPttKey(e)) { cancel(); return; }
      if (!allowed || down || timer) return;
      if (isModifierCode(hotkeys().talk.code)) timer = setTimeout(press, holdMs);
      else press();
    },
    keyup(e) { if (isPttKeyUp(e)) release(); },
    pointerdown: cancel,
    release,
  };
}

/**
 * The talk key (createTalkKey; ignored while typing in input/textarea/select/contenteditable) and
 * pointerdown/up/cancel/leave on the button. Press and release are paired: onPress fires once until the matching
 * release, whichever source started it; losing window focus also releases. Returns an unbind function.
 */
export function bindPushToTalk(opts: PttOpts): () => void {
  type Source = "key" | "pointer" | "external";
  let source: Source | null = null;

  const press = (s: Source) => {
    if (source) return;
    source = s;
    opts.onPress();
  };
  const release = (s: Source | "any") => {
    if (!source || (s !== "any" && s !== source)) return;
    source = null;
    opts.onRelease();
  };

  const talk = createTalkKey((down) => (down ? press("key") : release("key")));
  const onKeyDown = (e: KeyboardEvent) => talk.keydown(e, !isTypingTarget(e.target));
  const onKeyUp = (e: KeyboardEvent) => talk.keyup(e);
  const onAnyPointerDown = () => talk.pointerdown();
  const onBlur = () => { talk.release(); release("any"); };
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection; keeps focus where it was
    press("pointer");
  };
  const onPointerEnd = () => release("pointer");
  const onContextMenu = (e: Event) => e.preventDefault(); // long-press on touch

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  window.addEventListener("pointerdown", onAnyPointerDown, true);
  const b = opts.button;
  b?.addEventListener("pointerdown", onPointerDown);
  b?.addEventListener("pointerup", onPointerEnd);
  b?.addEventListener("pointercancel", onPointerEnd);
  b?.addEventListener("pointerleave", onPointerEnd);
  b?.addEventListener("contextmenu", onContextMenu);
  opts.external?.(() => press("external"), () => release("external"));

  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("pointerdown", onAnyPointerDown, true);
    b?.removeEventListener("pointerdown", onPointerDown);
    b?.removeEventListener("pointerup", onPointerEnd);
    b?.removeEventListener("pointercancel", onPointerEnd);
    b?.removeEventListener("pointerleave", onPointerEnd);
    b?.removeEventListener("contextmenu", onContextMenu);
    talk.release();
    release("any");
  };
}
