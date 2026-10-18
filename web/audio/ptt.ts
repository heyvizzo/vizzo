// Push-to-talk: hold Shift (outside inputs) or hold the given button.

export interface PttOpts {
  button?: HTMLElement;
  onPress: () => void;
  onRelease: () => void;
  /** Another source of presses, e.g. Shift held in the Electron app's browser pane (relayed over IPC). */
  external?: (press: () => void, release: () => void) => void;
}

/** Input types that are not text entry, so Shift stays free for push-to-talk. */
const NOT_TEXT_INPUT = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);

/** True for text-like input types (including the default empty type). Checkboxes and sliders are false. */
export function isTextInputType(type: string): boolean {
  return !NOT_TEXT_INPUT.has(type);
}

/** True if keyboard focus is in a text-entry control, where Shift is for typing capitals. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return isTextInputType(el.type);
  return false;
}

/** A lone Shift press (no Ctrl/Alt/Meta held), so shortcuts like Cmd+Shift+… don't start a turn. */
export function isPttKey(e: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): boolean {
  return e.key === "Shift" && !e.ctrlKey && !e.altKey && !e.metaKey;
}

/**
 * Shift keydown/keyup (auto-repeat ignored, ignored while typing in input/textarea/select/contenteditable) and
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

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat || !isPttKey(e) || isTypingTarget(e.target)) return;
    press("key");
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === "Shift") release("key");
  };
  const onBlur = () => release("any");
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
    b?.removeEventListener("pointerdown", onPointerDown);
    b?.removeEventListener("pointerup", onPointerEnd);
    b?.removeEventListener("pointercancel", onPointerEnd);
    b?.removeEventListener("pointerleave", onPointerEnd);
    b?.removeEventListener("contextmenu", onContextMenu);
    release("any");
  };
}
