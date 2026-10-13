// Push-to-talk: hold Space (outside inputs) or hold the given button.

export interface PttOpts { button?: HTMLElement; onPress: () => void; onRelease: () => void }

/** True if keyboard focus is in a text-entry control, where Space must type a space. */
function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

/**
 * Space keydown/keyup (auto-repeat ignored, ignored while typing in input/textarea/select/contenteditable) and
 * pointerdown/up/cancel/leave on the button. Press and release are paired: onPress fires once until the matching
 * release, whichever source started it; losing window focus also releases. Returns an unbind function.
 */
export function bindPushToTalk(opts: PttOpts): () => void {
  let source: "key" | "pointer" | null = null;

  const press = (s: "key" | "pointer") => {
    if (source) return;
    source = s;
    opts.onPress();
  };
  const release = (s: "key" | "pointer" | "any") => {
    if (!source || (s !== "any" && s !== source)) return;
    source = null;
    opts.onRelease();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code !== "Space" || isTypingTarget(e.target)) return;
    e.preventDefault(); // no page scroll, no click on a focused button
    if (e.repeat) return;
    press("key");
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code !== "Space") return;
    if (source === "key") e.preventDefault();
    release("key");
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
