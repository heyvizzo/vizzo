// The inline form of the page's bubbles (the comment bubble, web/cursor/commentOverlay.ts, and the thread panel,
// web/cursor/threadOverlay.ts): one row with a text field, a mic (dictation into the field, as the bubble's Dictate
// was) and Send (an arrow with Instant feedback on, a plus with it off: it adds to the list).
// Dictation is the chat's (web/chat/main.ts): it knows one "comment" at a time. The hub stands for all the forms on
// the page: it tells the chat one is open (comment.draft), and puts the dictated words into the active one (the
// last focused or recording). In the field, keys are for typing: a talk key that's a modifier dictates once it's held
// alone for FIELD_HOLD_MS; one that types nothing (an F key, or with ⌃/⌘) at once; one that types never does.
import type { CursorSample } from "../../shared/protocol.ts";
import { hotkeyLabel, hotkeys, isFunctionKey, isModifierOnly } from "../../shared/hotkeys.ts";
import { createTalkKey, isPttKey } from "../audio/ptt.ts";
import type { CommentState, DictationTranscript, PageCommentAction } from "./pageBridge.ts";

/** A modifier talk key held this long in a form's field, with no other key, dictates (shorter: a shortcut or a capital). */
export const FIELD_HOLD_MS = 300;

/** The talk key works in a form's field (it types nothing there). */
function talksInField(): boolean {
  const hk = hotkeys().talk;
  return isModifierOnly(hk) || isFunctionKey(hk.code) || hk.ctrl || hk.meta;
}

/** "hold Control" / "press F5": the talk key, for hints. */
export const talkHint = (): string => `hold ${hotkeyLabel(hotkeys().talk)}`;
const MAX_FIELD_PX = 160;

const ICON_MIC = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" fill="currentColor"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
const ICON_SEND = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_ADD = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;

export const INLINE_FORM_CSS = `
.if-form { display: flex; align-items: flex-end; gap: 2px; padding: 3px 3px 3px 10px; background: var(--ui-sunken); border: 1px solid var(--ui-line); border-radius: 18px; }
.if-form:focus-within { border-color: var(--ui-accent); box-shadow: 0 0 0 3px var(--ui-focus-ring); }
.if-form.rec { border-color: var(--ui-err); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ui-err) 20%, transparent); }
.if-field { flex: 1; min-width: 0; height: 28px; max-height: ${MAX_FIELD_PX}px; box-sizing: border-box; margin: 0; padding: 5px 0; resize: none; overflow-y: auto; font: inherit; line-height: 18px; color: var(--ui-text); background: transparent; border: 0; outline: none; }
.if-field::placeholder { color: var(--ui-placeholder); }
.if-form button.if-btn { flex: none; width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; border: 0; background: transparent; color: var(--ui-muted); cursor: pointer; }
.if-form button.if-btn:hover:not(:disabled) { color: var(--ui-text); background: var(--ui-hover); }
.if-form button.if-btn:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 1px; }
.if-form button.if-btn:disabled { opacity: .4; cursor: default; }
.if-form button.if-rec.on { color: var(--ui-on-accent); background: var(--ui-err); animation: if-pulse 1.2s ease-in-out infinite; }
.if-form.listening { border-color: var(--ui-err); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ui-err) 20%, transparent); }
.if-form.listening .if-field { cursor: default; }
.if-form.listening .if-field::placeholder { color: var(--ui-err-text); font-style: italic; }
.if-form button.if-rec.listen { color: var(--ui-on-accent); background: var(--ui-err); cursor: default; animation: if-pulse 1.2s ease-in-out infinite; }
.if-form button.if-rec.listen svg { animation: if-beat 1.2s ease-in-out infinite; }
.if-form button.if-send { color: var(--ui-on-accent); background: var(--ui-accent-gradient); }
.if-form button.if-send:hover:not(:disabled) { color: var(--ui-on-accent); background: var(--ui-accent-gradient-hover); }
.if-form button.if-send:disabled { color: var(--ui-muted); background: var(--ui-hover); }
.if-partial { font-size: 12px; color: var(--ui-muted); font-style: italic; overflow-wrap: anywhere; padding: 0 10px; }
@keyframes if-pulse { 50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--ui-err) 25%, transparent); } }
@keyframes if-beat { 50% { transform: scale(1.18); } }
@media (prefers-reduced-motion: reduce) { .if-form button.if-rec.on, .if-form button.if-rec.listen, .if-form button.if-rec.listen svg { animation: none; } }`;

/** `text` inserted over value[start, end), with a space on each side where it would touch a word. */
export function insertAtCaret(value: string, start: number, end: number, text: string): { value: string; caret: number } {
  const t = text.trim();
  if (!t) return { value, caret: end };
  const before = value.slice(0, start);
  const after = value.slice(end);
  const pre = before && !/\s$/.test(before) ? " " : "";
  const post = after && !/^[\s.,;:!?)]/.test(after) ? " " : "";
  const mid = pre + t + post;
  return { value: before + mid + after, caret: before.length + pre.length + t.length };
}

export interface InlineForm {
  /** The row (field, mic, send) and the live words under it. */
  root: HTMLElement;
  field: HTMLTextAreaElement;
  value(): string;
  clear(): void;
  focus(): void;
  /** Wants dictation (the talk key and always-listen go into it); the comment bubble is open for as long as it exists. */
  setOpen(open: boolean): void;
  /** Gone with its bubble: stops its dictation and tells the hub. */
  destroy(): void;
}

export interface InlineFormOpts {
  placeholder: string;
  /** Enter or the send button, with the field's trimmed text (never empty). */
  submit(text: string): void;
  /** Esc in the field. */
  escape?(empty: boolean): void;
  /** Open only while its field has focus or it's dictating (the thread panel); else open until destroyed. */
  openOnFocus?: boolean;
  /** Select this form immediately, before it receives keyboard focus (drawing tools). */
  activateOnCreate?: boolean;
  /** Keep talk-key dictation running while drawing/tools take field focus. */
  keepDictationOnBlur?: boolean;
  /** Preserve tool/editor focus when an asynchronous transcript arrives. */
  focusAfterDictation?: boolean;
  /** Called after insertion with the exact spoken text range, excluding added spaces. */
  onDictation?(text: string, metadata: DictationTranscript, range: { start: number; end: number }, previousText: string): void;
}

export interface FormHub {
  /** The chat's dictation state (comment.state). */
  update(state: CommentState): void;
  state(): CommentState;
  /** Dictated words: into the active form, at its caret. */
  insert(text: string, dictation?: DictationTranscript): void;
  /** Capture the intended recipient before the recording-start IPC roundtrip. */
  prepareDictation(): void;
  /** Release an in-field talk-key hold even when drawing input swallowed the native event. */
  releaseTalkKey(): void;
  /** Keyboard focus is in a form's field (keys there type; the field handles its own talk-key hold). */
  typing(): boolean;
  /** A comment from a form: sent now, or added to the list (the chat decides). `threadId`: from that thread's panel. */
  send(text: string, sample: CursorSample, threadId?: string): void;
  create(opts: InlineFormOpts): InlineForm;
}

export interface FormHubOpts {
  send(action: PageCommentAction): void;
  /** Push-to-talk, as the talk key outside a field: the talk key in a field (talksInField). */
  ptt(down: boolean): void;
  /** Called after every state change (the bubbles may need to move: the live words change their height). */
  changed?(): void;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

interface FormView {
  form: InlineForm;
  open: boolean;
  render(): void;
  put(text: string, dictation?: DictationTranscript): void;
  isFocused(): boolean;
  /** Remember the field's selection (dictated words go there). */
  keepSel(): void;
  /** Open only while focused or dictating: closes once neither is true any more. */
  settle(): void;
}

export function createFormHub(opts: FormHubOpts): FormHub {
  let state: CommentState = { instant: true, recording: false, transcribing: false, partial: "" };
  const forms = new Set<FormView>();
  let active: FormView | null = null;
  let draftOpen = false;
  const recipients = new Map<string, FormView | null>();
  let pendingRecipient: FormView | null | undefined;
  let talkOwner: FormView | null = null;

  const syncDraft = () => {
    const open = [...forms].some((f) => f.open);
    if (open === draftOpen) return;
    draftOpen = open;
    opts.send({ type: "comment.draft", open });
  };
  const target = (): FormView | null => (active && active.open && forms.has(active) ? active : [...forms].find((f) => f.open) ?? null);
  const prepareDictation = () => { if (!state.recording && !state.transcribing) pendingRecipient = target(); };
  const recordingTarget = () => state.dictationId ? recipients.get(state.dictationId) ?? null : target();
  const forgetRecipient = (view: FormView) => {
    for (const [id, recipient] of recipients) if (recipient === view) recipients.set(id, null);
    if (pendingRecipient === view) pendingRecipient = null;
  };
  const renderAll = () => {
    for (const f of forms) f.render();
    opts.changed?.();
  };

  // The talk key in a field dictates into it (a modifier once it's held alone; another key in the meantime was a
  // shortcut or a capital).
  const talk = createTalkKey((down) => {
    if (!down) { opts.ptt(false); return; }
    const view = talkOwner;
    if (!view) return;
    view.keepSel();
    active = view;
    prepareDictation();
    opts.ptt(true);
  }, FIELD_HOLD_MS);
  function talkUp(): void {
    talk.release();
    talkOwner = null;
  }

  window.addEventListener("keyup", (event) => talk.keyup(event), true);
  window.addEventListener("blur", talkUp);
  window.addEventListener("pagehide", talkUp);

  function create(o: InlineFormOpts): InlineForm {
    const root = h("div", "if-wrap");
    const row = h("div", "if-form");
    const field = h("textarea", "if-field");
    field.rows = 1;
    field.placeholder = o.placeholder;
    field.spellcheck = true;
    const rec = h("button", "if-btn if-rec");
    rec.type = "button";
    rec.innerHTML = ICON_MIC;
    const send = h("button", "if-btn if-send");
    send.type = "button";
    const partial = h("div", "if-partial");
    partial.setAttribute("aria-live", "polite");
    row.append(field, rec, send);
    root.append(row, partial);
    /** Where dictated words go: the field's selection when dictation started (or the last one seen). */
    let sel = { start: 0, end: 0 };
    const keepSel = () => { sel = { start: field.selectionStart, end: field.selectionEnd }; };

    const fit = () => {
      field.style.height = "0";
      field.style.height = `${Math.min(MAX_FIELD_PX, field.scrollHeight)}px`;
    };
    const mine = () => recordingTarget() === view && state.recording;
    /** Dictating, or its words are still on the way: closing now would drop them. */
    const busy = () => recordingTarget() === view && (state.recording || state.transcribing);
    const view: FormView = {
      keepSel: () => keepSel(),
      open: !o.openOnFocus,
      form: null as unknown as InlineForm,
      isFocused: () => (field.getRootNode() as ShadowRoot | Document).activeElement === field,
      render() {
        const recording = mine();
        // A turn is being recorded (always-listen): its words go to the thread, not into the field.
        const listening = !!state.listening && !recording;
        const empty = !field.value.trim();
        row.classList.toggle("rec", recording);
        row.classList.toggle("listening", listening);
        rec.classList.toggle("on", recording);
        rec.classList.toggle("listen", listening);
        field.disabled = listening;
        field.placeholder = listening ? "Listening…" : o.placeholder;
        rec.dataset.tip = listening ? "Listening…" : recording ? "Stop dictating" : `Dictate into the field (or ${talkHint()})`;
        rec.setAttribute("aria-label", listening ? "Listening" : recording ? "Stop dictating" : "Dictate");
        rec.setAttribute("aria-pressed", String(recording || listening));
        send.innerHTML = state.instant ? ICON_SEND : ICON_ADD;
        send.dataset.tip = state.instant ? "Send now (Enter)" : "Add to the list; send the list with the arrow next to the address bar (Enter)";
        send.setAttribute("aria-label", state.instant ? "Send" : "Add to the list");
        send.disabled = empty || listening;
        // The placeholder says it on an empty field; text in it would hide that.
        partial.textContent = recording ? state.partial || "Listening…" : busy() ? "Transcribing…" : listening && !empty ? "Listening…" : "";
        partial.hidden = !partial.textContent;
      },
      settle() {
        if (o.openOnFocus && view.open && !view.isFocused() && !busy()) setOpen(false);
      },
      put(text, dictation) {
        const previousText = field.value;
        const spoken = text.trim();
        const { value, caret } = insertAtCaret(previousText, sel.start, sel.end, text);
        field.value = value;
        field.setSelectionRange(caret, caret);
        sel = { start: caret, end: caret };
        fit();
        view.render();
        if (dictation && spoken) o.onDictation?.(spoken, dictation, { start: caret - spoken.length, end: caret }, previousText);
        if (o.focusAfterDictation !== false && (!o.keepDictationOnBlur || view.isFocused())) field.focus({ preventScroll: true });
      },
    };
    const setOpen = (open: boolean) => {
      if (!open) {
        if (busy()) opts.send({ type: "comment.record", on: false });
        if (talkOwner === view) talkUp();
        forgetRecipient(view);
      }
      view.open = open;
      syncDraft();
    };
    const submit = () => {
      const text = field.value.trim();
      if (!text) return field.focus({ preventScroll: true });
      if (mine()) opts.send({ type: "comment.record", on: false });
      o.submit(text);
    };

    // Buttons don't take focus: the caret stays in the field (dictation goes where it is).
    for (const b of [rec, send]) b.addEventListener("pointerdown", (e) => e.preventDefault());
    rec.onclick = () => {
      if (state.listening && !mine()) return; // a turn is being recorded: the field is off until it's sent
      keepSel();
      // Stopping another form's recording must not retarget its eventual transcript.
      const on = !state.recording;
      active = view;
      if (o.openOnFocus) setOpen(true);
      field.focus({ preventScroll: true });
      if (on) prepareDictation();
      opts.send({ type: "comment.record", on });
      renderAll();
    };
    send.onclick = submit;
    field.addEventListener("input", () => { keepSel(); fit(); view.render(); });
    field.addEventListener("select", keepSel);
    field.addEventListener("keyup", keepSel);
    field.addEventListener("pointerup", keepSel);
    field.addEventListener("focus", () => {
      if (active !== view) { active = view; renderAll(); }
      if (o.openOnFocus) setOpen(true);
    });
    field.addEventListener("blur", () => {
      if (!o.keepDictationOnBlur) talkUp();
      view.settle();
    });
    field.addEventListener("keyup", (e) => talk.keyup(e));
    field.addEventListener("keydown", (e) => {
      if (isPttKey(e)) {
        if (!talksInField()) return;
        if (!isModifierOnly(hotkeys().talk)) e.preventDefault();
        if (!e.repeat) talkOwner = view;
        talk.keydown(e, true);
        return;
      }
      talk.keydown(e, true); // another key: a shortcut or a capital, not talking
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        o.escape?.(!field.value.trim() && !busy());
      }
    });

    const form: InlineForm = {
      root,
      field,
      value: () => field.value,
      clear() { field.value = ""; sel = { start: 0, end: 0 }; fit(); view.render(); },
      focus: () => field.focus({ preventScroll: true }),
      setOpen,
      destroy() {
        if (!forms.has(view)) return;
        if (busy()) opts.send({ type: "comment.record", on: false });
        if (view.isFocused() || talkOwner === view) talkUp();
        forgetRecipient(view);
        forms.delete(view);
        if (active === view) active = null;
        syncDraft();
      },
    };
    view.form = form;
    forms.add(view);
    if (o.activateOnCreate) active = view;
    view.render();
    syncDraft();
    return form;
  }

  return {
    update(next) {
      if (next.dictationId && !recipients.has(next.dictationId)) {
        recipients.set(next.dictationId, pendingRecipient === undefined ? target() : pendingRecipient);
        pendingRecipient = undefined;
        // Completed recordings are never routed again; keep memory bounded during long sessions.
        if (recipients.size > 100) recipients.delete(recipients.keys().next().value!);
      }
      state = next;
      renderAll();
      for (const f of forms) f.settle(); // dictated into a panel's form that has since lost focus
    },
    state: () => state,
    insert(text, dictation) {
      if (!text.trim()) return;
      const recipient = dictation ? recipients.get(dictation.id) : target();
      if (recipient && forms.has(recipient) && recipient.open) recipient.put(text, dictation);
      if (dictation) recipients.set(dictation.id, null);
    },
    prepareDictation,
    releaseTalkKey: talkUp,
    typing: () => [...forms].some((f) => f.isFocused()),
    send: (text, sample, threadId) => opts.send({ type: "comment.send", text, sample, ...(threadId ? { threadId } : {}) }),
    create,
  };
}
