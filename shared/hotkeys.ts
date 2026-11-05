// The app's keyboard shortcuts, set in Settings → Keyboard (saved with the chat's settings, web/chat/settings.ts).
// - talk: held, it's push-to-talk (Control by default). A modifier alone counts once it's held with no other key, so
//   shortcuts that start with it (Ctrl+M, Ctrl-click) don't talk.
// - comment: comment mode (Ctrl+M by default). A tap turns it on (another tap or Esc turns it off); held, it's on until
//   the key comes up (electron/main.ts).
// Each process keeps the current ones here (setHotkeys): main, every preload, the chat sidebar.

export type HotkeyAction = "talk" | "comment";

/** `code` is KeyboardEvent.code, except that both sides of a modifier are one code ("Control", "Shift", "Alt", "Meta"). */
export interface Hotkey { code: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }
export type Hotkeys = Record<HotkeyAction, Hotkey>;

/** A key event's fields that matter (a DOM KeyboardEvent, or Electron's Input via fromElectronInput). */
export interface KeyLike { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }

const bare = { ctrl: false, alt: false, shift: false, meta: false };
export const DEFAULT_HOTKEYS: Hotkeys = {
  talk: { code: "Control", ...bare },
  comment: { code: "KeyM", ...bare, ctrl: true },
};

export const HOTKEY_LABELS: Record<HotkeyAction, string> = { talk: "Push to talk", comment: "Comment mode" };

/** A modifier alone held this long (with no other key or click) is push-to-talk. The chat's pre-roll covers it. */
export const TALK_HOLD_MS = 200;

const MODIFIERS = ["Control", "Shift", "Alt", "Meta"] as const;
type Modifier = typeof MODIFIERS[number];
const FLAG: Record<Modifier, "ctrl" | "shift" | "alt" | "meta"> = { Control: "ctrl", Shift: "shift", Alt: "alt", Meta: "meta" };

/** "ControlLeft" / "ControlRight" → "Control"; other codes as they are. */
export function normalizeCode(code: string): string {
  const m = /^(Control|Shift|Alt|Meta)(Left|Right)$/.exec(code);
  return m ? m[1]! : code;
}

export const isModifierCode = (code: string): code is Modifier => (MODIFIERS as readonly string[]).includes(code);
/** Held alone: a modifier with no other modifiers. */
export const isModifierOnly = (hk: Hotkey): boolean => isModifierCode(hk.code) && !hk.ctrl && !hk.alt && !hk.shift && !hk.meta;
/** F1–F24 type nothing, so they work in text fields too. */
export const isFunctionKey = (code: string): boolean => /^F([1-9]|1[0-9]|2[0-4])$/.test(code);

/** The key going down is this hotkey: its key, with exactly its modifiers (a modifier key's own flag is ignored). */
export function matchesDown(e: KeyLike, hk: Hotkey): boolean {
  const code = normalizeCode(e.code);
  if (code !== hk.code) return false;
  const own = isModifierCode(code) ? FLAG[code] : null;
  const same = (flag: "ctrl" | "alt" | "shift" | "meta", on: boolean) => flag === own || on === hk[flag];
  return same("ctrl", e.ctrlKey) && same("alt", e.altKey) && same("shift", e.shiftKey) && same("meta", e.metaKey);
}

/** The key coming up ends a hold of this hotkey: its key, or one of its modifiers. */
export function endsHold(e: { code: string }, hk: Hotkey): boolean {
  const code = normalizeCode(e.code);
  return code === hk.code || (isModifierCode(code) && hk[FLAG[code]]);
}

export const sameHotkey = (a: Hotkey, b: Hotkey): boolean =>
  a.code === b.code && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.meta === b.meta;

function normalizeHotkey(v: unknown, fallback: Hotkey): Hotkey {
  if (!v || typeof v !== "object") return fallback;
  const o = v as Record<string, unknown>;
  if (typeof o.code !== "string" || !/^[A-Za-z0-9]{1,24}$/.test(o.code) || o.code === "Escape") return fallback;
  const code = normalizeCode(o.code);
  const hk = { code, ctrl: o.ctrl === true, alt: o.alt === true, shift: o.shift === true, meta: o.meta === true };
  if (isModifierCode(code)) hk[FLAG[code]] = false; // its own flag is implied
  return hk;
}

/** Saved hotkeys (any shape) made whole and valid; two actions on the same key fall back to the defaults. */
export function normalizeHotkeys(saved: unknown): Hotkeys {
  const o = saved && typeof saved === "object" ? saved as Record<string, unknown> : {};
  const out: Hotkeys = { talk: normalizeHotkey(o.talk, DEFAULT_HOTKEYS.talk), comment: normalizeHotkey(o.comment, DEFAULT_HOTKEYS.comment) };
  return sameHotkey(out.talk, out.comment) ? { ...DEFAULT_HOTKEYS } : out;
}

/** The app menu's and macOS's own shortcuts (electron/main.ts buildMenu): taken. */
const RESERVED: Hotkey[] = ["KeyL", "KeyR", "KeyO", "Comma", "KeyQ", "KeyW", "KeyH", "KeyM", "KeyC", "KeyV", "KeyX", "KeyZ", "KeyA", "Tab", "Space"]
  .map((code) => ({ code, ctrl: false, alt: false, shift: false, meta: true }))
  .concat([{ code: "KeyI", ctrl: false, alt: true, shift: false, meta: true }, { code: "KeyZ", ctrl: false, alt: false, shift: true, meta: true }]);

/** Why this can't be the action's hotkey (null: it can). `others`: the other actions' hotkeys. */
export function hotkeyProblem(action: HotkeyAction, hk: Hotkey, others: Partial<Hotkeys>): string | null {
  if (hk.code === "Escape") return "Esc is taken: it stops the voice.";
  for (const [other, key] of Object.entries(others) as [HotkeyAction, Hotkey][]) {
    if (other !== action && sameHotkey(key, hk)) return `${hotkeyLabel(hk)} is already ${HOTKEY_LABELS[other].toLowerCase()}.`;
  }
  if (RESERVED.some((r) => sameHotkey(r, hk))) return `${hotkeyLabel(hk)} is taken by the app's menus or macOS.`;
  // A key that types (a letter, Space, Return…) would type as well; ⌃/⌥/⌘ with it, an F key or a modifier don't.
  const typesNothing = isModifierCode(hk.code) || isFunctionKey(hk.code) || hk.code === "CapsLock" || hk.ctrl || hk.alt || hk.meta;
  if (!typesNothing) return `${hotkeyLabel(hk)} types: add ⌃, ⌥ or ⌘, or use an F key or a modifier on its own.`;
  // A modifier alone toggling comment mode would toggle it with every shortcut (⇧ with every capital).
  if (action === "comment" && isModifierOnly(hk)) return "Comment mode needs a key with it (such as ⌃M), not a modifier on its own.";
  return null;
}

const KEY_NAMES: Record<string, string> = {
  Control: "Control", Shift: "Shift", Alt: "Option", Meta: "Command", CapsLock: "Caps Lock",
  Space: "Space", Enter: "Return", Tab: "Tab", Backspace: "Delete", Delete: "Forward Delete",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Home: "Home", End: "End", PageUp: "Page Up", PageDown: "Page Down",
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'",
  Comma: ",", Period: ".", Slash: "/", IntlBackslash: "§",
};

/** How a hotkey reads: "Control", "Caps Lock", "⌃M", "⌥⇧Space" (the macOS order: ⌃⌥⇧⌘). */
export function hotkeyLabel(hk: Hotkey): string {
  const key = KEY_NAMES[hk.code] ?? hk.code.replace(/^Key|^Digit|^Numpad/, "");
  const mods = (hk.ctrl ? "⌃" : "") + (hk.alt ? "⌥" : "") + (hk.shift ? "⇧" : "") + (hk.meta ? "⌘" : "");
  if (!mods) return key;
  return mods + (isModifierCode(hk.code) ? { Control: "⌃", Shift: "⇧", Alt: "⌥", Meta: "⌘" }[hk.code] : key);
}

/** Electron's before-input-event Input as a KeyLike. */
export function fromElectronInput(input: { code: string; control: boolean; alt: boolean; shift: boolean; meta: boolean }): KeyLike {
  return { code: input.code, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift, metaKey: input.meta };
}

// ── the current hotkeys, in this process ──

let current: Hotkeys = DEFAULT_HOTKEYS;
const listeners = new Set<(hk: Hotkeys) => void>();
export const hotkeys = (): Hotkeys => current;
export function setHotkeys(next: unknown): void {
  const hk = normalizeHotkeys(next);
  if (sameHotkey(hk.talk, current.talk) && sameHotkey(hk.comment, current.comment)) return;
  current = hk;
  for (const cb of listeners) cb(hk);
}
/** Called after each change. */
export function onHotkeys(cb: (hk: Hotkeys) => void): void {
  listeners.add(cb);
}
