import { displayTitle, type ThreadDeleteMode, type ThreadDeletePreview, type ThreadInfo, type ThreadMessage, type ThreadState } from "../../shared/threads.ts";
import { stripVoiceCues } from "../../shared/cues.ts";
import type { HarnessSessionInfo } from "../../shared/harnessSession.ts";
import { element as h } from "../common.ts";
import { sessionActions, sessionBadge } from "../sessionBadge.ts";
import { drawingPreview, drawingPreviewOpen } from "./drawingPreview.ts";
import { talkHint, type FormDraft, type FormHub, type InlineForm } from "./inlineForm.ts";
import { renderMarkdown } from "./markdown.ts";
import type { ConvoEntry, HeldComment, OrbState, PageChangesStatus, PageThreadDeletePreview, PageThreads, PageHeldAction, PagePanelAction, PageThreadAction } from "./pageBridge.ts";
import { enablePanelDrag } from "./panelDrag.ts";
import { PANEL_GAP, PANEL_HEIGHT, PANEL_WIDTH, PANEL_MIN_WIDTH, PANEL_MIN_HEIGHT, panelPosition, tailOffset, type Spot } from "./threadLayout.ts";

/** The panel header's delete button. */
const ICON_TRASH = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 4.5h11M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6M6.8 7v4.5M9.2 7v4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_STOP = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor"/></svg>`;
/**
 * A marker's look: its thread's state, or "asking" when the thread's last reply asked you something, or when the app
 * was closed mid-run (interrupted: it waits for Resume).
 */
export const markerLook = (t: ThreadInfo): string => ((t.awaitingReply || t.interrupted) && (t.state === "idle" || t.state === "pending") ? "asking" : t.state);
/** The words for the "asking" look. */
export const askingLabel = (t: ThreadInfo | null | undefined): string => (t?.interrupted ? "interrupted" : "asking you");
export interface PanelSnapshot {
  threadId: string | null;
  draft?: FormDraft;
  scroll: number;
  details: string[];
  size?: { width: number; height: number };
  offset: { x: number; y: number; side: "above" | "below" } | null;
}

const KEEP_DELETE = { label: "Delete, keep uncommitted", mode: "keep" } as const;

/** The first action is the focused default. Queued feedback has no server preview. */
export function deleteConfirmation(preview: ThreadDeletePreview | "queued"): { text: string; actions: { label: string; mode: ThreadDeleteMode }[] } {
  if (preview === "queued") return { text: "Delete this feedback? It won't be sent.", actions: [{ label: "Delete", mode: "keep" }] };
  switch (preview.state) {
    case "none": return { text: preview.reason ?? "Delete this thread?", actions: [{ label: "Delete", mode: "keep" }] };
    case "complete": return { text: preview.reason ?? "Delete this thread?", actions: [{ label: "Commit and delete", mode: "commit" }, KEEP_DELETE] };
    case "incomplete": return { text: preview.reason ?? "The last task left unfinished changes.", actions: [KEEP_DELETE] };
    case "working": return { text: "Its work will be stopped part-way and kept uncommitted.", actions: [{ label: "Stop and delete", mode: "keep" }] };
  }
}

type DeleteConfirmation = { kind: "generic" } | { kind: "checking"; requestId: string } | { kind: "ready"; preview: ThreadDeletePreview | "queued" } | { kind: "error"; message: string };

/** A finished thread (idle, pending) has no label: the marker's check says it. */
export const STATE_LABEL: Record<ThreadState, string> = { running: "working", pending: "", idle: "", failed: "failed", queued: "not sent" };

/** An assistant's short reply, rendered from its Markdown: it's meant to be plain, but a reply without its SPOKEN line
 *  falls back to the answer's first paragraph, markup and all. */
function assistantText(text: string): HTMLElement {
  const md = renderMarkdown(stripVoiceCues(text));
  md.classList.add("th-text");
  return md;
}

/** An answer's full text, rendered from its Markdown. */
function fullAnswer(detail: string): HTMLElement {
  const md = renderMarkdown(detail);
  md.classList.add("th-detail");
  return md;
}

/** The same panel UI can live in the page overlay or in a bounded app-owned view. */
export interface PanelSurface {
  viewport(): { sx: number; sy: number; vw: number; vh: number };
  place(rect: { x: number; y: number; width: number; height: number }): void;
  zoom(): number;
}
export interface PanelActions {
  layer: HTMLElement;
  forms: FormHub;
  send(action: PageThreadAction | PagePanelAction | PageHeldAction): void;
  copyText?(text: string): Promise<void>;
  releaseSession?(sessionId: string): Promise<void>;
  continueSession?(sessionId: string, context?: string): Promise<void>;
}

export function createThreadPanels(opts: PanelActions & {
  thread(id: string): ThreadInfo | undefined;
  spot(id: string | null): Spot | null;
  queued(path: string): ThreadMessage[];
  submit(id: string, text: string): boolean;
  orbState(): OrbState;
  changed(): void;
  surface?: PanelSurface;
}) {
  const { layer, surface } = opts;
  const viewport = () => surface?.viewport() ?? { sx: scrollX, sy: scrollY, vw: innerWidth, vh: innerHeight };
  let changesStatus: PageChangesStatus = null;
  let sourceControlEnabled = false;
  let nextDeletePreview = 0;
  let deleting = new Set<string>();
  let continuing = new Set<string>();
  let connected = true;
  // Sizes belong to individual tasks (null is the conversation), across close/reopen and live updates.
  const panelSizes = new Map<string | null, { width: number; height: number }>();
  /** `view`: the viewport when it opened; the panel is placed against it, so it stays put as the page scrolls. */
  /** `threadId` null: the orb's panel (the conversation; no form). */
  let panel: {
    threadId: string | null; root: HTMLElement; resize: HTMLElement; form: InlineForm | null; confirming: DeleteConfirmation | null; openDetails: Set<string>;
    /** A resized or dragged panel keeps its chosen position relative to its marker until closed. */
    offset: { x: number; y: number; side: "above" | "below" } | null;
    /** Messages already shown: a new one is scrolled into view. */
    seen: Set<string>;
    /**
     * The new message being scrolled to, until it's reached: the body is rebuilt on every update, which would stop a
     * smooth scroll half-way (the thread's state changes right after its message arrives).
     */
    goal: string | null;
    view: { sx: number; sy: number; vw: number; vh: number };
  } | null = null;
  let entries: ConvoEntry[] = [];
  let conversationSession: HarnessSessionInfo | null = null;
  let held: HeldComment[] = [];
  /** Debugging → Details: edited files. */
  let details = false;
  /** General preferences → Solver session: native sessions and their resume commands. */
  let showSession = false;
  let fullAnswers = true;

  // ── panel ──

  let panelLeft = 0, panelTop = 0;
  function panelRect(root: HTMLElement): DOMRect {
    return surface ? new DOMRect(panelLeft, panelTop, root.offsetWidth, root.offsetHeight) : root.getBoundingClientRect();
  }

  function panelDrag(root: HTMLElement): void {
    enablePanelDrag(root, ".th-head", (left, top) => {
      const p = panel;
      if (!p || p.root !== root) return;
      const s = opts.spot(p.threadId);
      if (!s) return;
      p.offset = {
        x: left + (s.fixed ? 0 : scrollX) - s.x,
        y: top + (s.fixed ? 0 : scrollY) - s.y,
        side: root.dataset.side as "above" | "below",
      };
      p.view = viewport();
      root.classList.add("detached");
      placePanel();
    }, surface ? { rect: () => panelRect(root), zoom: surface.zoom } : undefined);
  }

  function panelResizeHandles(root: HTMLElement): HTMLElement {
    const handles = h("div", "th-resize");
    type Corner = "sw" | "se";
    let drag: { id: number; corner: Corner; rect: DOMRect; x: number; y: number } | null = null;
    const resize = (corner: Corner, rect: DOMRect, dx: number, dy: number) => {
      const p = panel;
      if (!p || p.root !== root) return;
      const s = opts.spot(p.threadId);
      if (!s) return;
      const west = corner === "sw";
      const maxWidth = Math.max(1, west ? rect.right - PANEL_GAP : viewport().vw - PANEL_GAP - rect.left);
      const maxHeight = Math.max(1, viewport().vh - PANEL_GAP - rect.top);
      // Leave room for the header, composer and a readable slice of the scrollable history.
      const chrome = root.offsetHeight - (root.querySelector<HTMLElement>(".th-body")?.offsetHeight ?? 0);
      const minHeight = Math.max(PANEL_MIN_HEIGHT, chrome + 48);
      const width = Math.max(Math.min(PANEL_MIN_WIDTH, maxWidth), Math.min(rect.width + (west ? -dx : dx), maxWidth));
      const height = Math.max(Math.min(minHeight, maxHeight), Math.min(rect.height + dy, maxHeight));
      const left = west ? rect.right - width : rect.left;
      const top = rect.top;
      panelSizes.set(p.threadId, { width, height });
      p.offset = { x: left + (s.fixed ? 0 : scrollX) - s.x, y: top + (s.fixed ? 0 : scrollY) - s.y, side: root.dataset.side as "above" | "below" };
      p.view = viewport();
      placePanel();
    };
    for (const [corner, label] of Object.entries({ sw: "bottom left", se: "bottom right" }) as [Corner, string][]) {
      const handle = h("button", "th-resize-handle");
      handle.type = "button";
      handle.dataset.corner = corner;
      handle.setAttribute("aria-label", `Resize from ${label}`);
      handle.dataset.tip = "Drag to resize. Arrow keys resize; Home resets the size.";
      handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || !panel || panel.root !== root) return;
        e.preventDefault();
        drag = { id: e.pointerId, corner, rect: panelRect(root), x: surface ? e.screenX : e.clientX, y: surface ? e.screenY : e.clientY };
        root.setPointerCapture(e.pointerId);
        root.classList.add("resizing");
      });
      handle.addEventListener("keydown", (e) => {
        if (!panel || panel.root !== root) return;
        if (e.key === "Home") {
          e.preventDefault();
          panelSizes.delete(panel.threadId);
          panel.offset = null;
          root.classList.remove("detached");
          placePanel();
          return;
        }
        const step = e.shiftKey ? 40 : 10;
        const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        if (!delta) return;
        e.preventDefault();
        resize(corner, panelRect(root), delta[0]!, delta[1]!);
      });
      handles.append(handle);
    }
    root.addEventListener("pointermove", (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      e.preventDefault();
      const dx = surface ? (e.screenX - drag.x) / surface.zoom() : e.clientX - drag.x;
      const dy = surface ? (e.screenY - drag.y) / surface.zoom() : e.clientY - drag.y;
      resize(drag.corner, drag.rect, dx, dy);
    });
    const end = (e: PointerEvent) => {
      if (!drag || drag.id !== e.pointerId) return;
      drag = null;
      root.classList.remove("resizing");
      if (root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
    };
    root.addEventListener("pointerup", end);
    root.addEventListener("pointercancel", end);
    root.addEventListener("lostpointercapture", end);
    return handles;
  }

  function closePanel(): void {
    if (!panel) return;
    const p = panel;
    panel = null;
    p.form?.destroy();
    p.root.remove();
    if (p.threadId !== null) opts.send({ type: "thread.panel", threadId: null });
    opts.changed();
  }

  function openPanel(threadId: string, saved?: PanelSnapshot): void {
    const thread = opts.thread(threadId);
    if (!thread) return;
    closePanel();
    const root = h("div", "th-panel");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", displayTitle(thread.title));
    layer.append(root);
    panelDrag(root);
    const queued = thread.state === "queued";
    const form = opts.forms.create({
      draft: saved?.draft,
      placeholder: queued ? "Add to this feedback…" : `Follow up… type, or ${talkHint()} to talk`,
      submit: (text) => { if (!deleting.has(threadId) && opts.submit(threadId, text)) { form.clear(); form.focus(); } },
      escape: (empty) => { if (empty) closePanel(); else form.field.blur(); },
      // Open while the panel is: the panel is the focus, so talking dictates into it whether or not the field has focus.
      activateOnCreate: true,
    });
    panel = { threadId, root, resize: panelResizeHandles(root), offset: saved?.offset ?? null, form, confirming: null, openDetails: new Set(saved?.details), seen: new Set(), goal: null, view: viewport() };
    renderPanel();
    opts.changed();
    if (!saved) opts.send({ type: "thread.focus", threadId });
    opts.send({ type: "thread.panel", threadId });
    if (!saved) root.querySelector<HTMLButtonElement>(".th-close")?.focus({ preventScroll: true });
    else if (saved.draft?.focused) form.focus();
  }

  /** The orb's panel: the conversation as the sidebar shows it. */
  function openCentral(saved?: PanelSnapshot): void {
    closePanel();
    const root = h("div", "th-panel");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Conversation");
    layer.append(root);
    panelDrag(root);
    panel = { threadId: null, root, resize: panelResizeHandles(root), offset: saved?.offset ?? null, form: null, confirming: null, openDetails: new Set(saved?.details), seen: new Set(), goal: null, view: { sx: 0, sy: 0, vw: viewport().vw, vh: viewport().vh } };
    renderPanel();
    opts.changed();
    if (!saved) root.querySelector<HTMLButtonElement>(".th-close")?.focus({ preventScroll: true });
  }

  function placePanel(): void {
    if (!panel) return;
    const s = opts.spot(panel.threadId);
    if (!s) return;
    // The orb's panel is fixed like the orb, placed against the viewport as it is now.
    const view = { sx: s.fixed ? 0 : panel.view.sx, sy: s.fixed ? 0 : panel.view.sy, vw: viewport().vw, vh: viewport().vh };
    panel.root.classList.toggle("fixed", s.fixed);
    const size = panelSizes.get(panel.threadId);
    const width = Math.min(size?.width ?? PANEL_WIDTH, Math.max(1, view.vw - 2 * PANEL_GAP));
    const maxHeight = Math.max(1, view.vh - 2 * PANEL_GAP);
    panel.root.style.width = `${width}px`;
    panel.root.style.height = size ? `${Math.min(size.height, maxHeight)}px` : "";
    panel.root.style.maxHeight = `${size ? maxHeight : Math.min(PANEL_HEIGHT, maxHeight)}px`;
    const height = panel.root.offsetHeight || 300;
    let { left, top, side, tailRight } = panelPosition(s.x, s.y, height, view, s.r, width);
    if (panel.offset) {
      left = Math.max(view.sx + PANEL_GAP, Math.min(s.x + panel.offset.x, view.sx + view.vw - width - PANEL_GAP));
      top = Math.max(view.sy + PANEL_GAP, Math.min(s.y + panel.offset.y, view.sy + view.vh - height - PANEL_GAP));
      side = panel.offset.side;
      tailRight = tailOffset(left + width, s.x, width);
    }
    if (size) top = Math.max(view.sy + PANEL_GAP, Math.min(top, view.sy + view.vh - height - PANEL_GAP));
    if (surface) {
      top = Math.max(PANEL_GAP, Math.min(top, view.vh - height - PANEL_GAP));
      panelLeft = left; panelTop = top;
      // The small gutter contains the tail and shadow. All other page content stays clickable.
      panel.root.style.left = panel.root.style.top = `${PANEL_GAP}px`;
      surface.place({ x: left - PANEL_GAP, y: top - PANEL_GAP, width: width + 2 * PANEL_GAP, height: height + 2 * PANEL_GAP });
    } else {
      panel.root.style.left = `${left}px`;
      panel.root.style.top = `${top}px`;
    }
    panel.root.dataset.side = side;
    panel.root.style.setProperty("--tail-right", `${tailRight}px`);
  }

  function renderMessage(msg: ThreadMessage, openDetails: Set<string>): HTMLElement {
    const row = h("div", `th-msg role-${msg.role} kind-${msg.kind}`);
    const who = msg.role === "user" ? "You" : msg.role === "assistant" ? "Assistant" : "System";
    const time = new Date(msg.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    row.append(h("div", "th-meta", `${who} · ${msg.kind} · ${time}`), msg.role === "assistant" ? assistantText(msg.text) : h("div", "th-text", msg.role === "user" ? msg.text : stripVoiceCues(msg.text)));
    if (msg.annotation) row.append(drawingPreview(msg.annotation));
    if (msg.detail && fullAnswers) {
      const d = h("details");
      d.open = openDetails.has(msg.id);
      d.addEventListener("toggle", () => { if (d.open) openDetails.add(msg.id); else openDetails.delete(msg.id); });
      d.append(h("summary", undefined, "Full answer"), fullAnswer(msg.detail));
      row.append(d);
    }
    if (msg.filesTouched?.length && details) row.append(h("div", "th-files", `Edited: ${msg.filesTouched.join(", ")}`));
    return row;
  }

  function continueAction(t: ThreadInfo): HTMLElement {
    const pending = continuing.has(t.threadId);
    const go = h("button", "th-continue", t.interrupted ? "Resume" : "Continue");
    go.type = "button";
    go.disabled = pending || deleting.has(t.threadId) || !connected || t.canContinue === false;
    go.dataset.tip = pending ? "Starting the continuation…" : !connected ? "Server not connected"
      : t.canContinue === false ? "The previous session is unavailable" : "Continue the unfinished request in its session";
    go.onclick = () => {
      opts.send({ type: "thread.continue", threadId: t.threadId });
    };
    const row = h("div", "th-held");
    row.append(go);
    return row;
  }

  function beginDeleteConfirm(t: ThreadInfo): void {
    if (panel?.threadId !== t.threadId) return;
    if (t.state === "queued") panel.confirming = { kind: "ready", preview: "queued" };
    else if (!sourceControlEnabled) panel.confirming = { kind: "generic" };
    else {
      const requestId = `${performance.timeOrigin}-${++nextDeletePreview}`;
      panel.confirming = { kind: "checking", requestId };
      opts.send({ type: "thread.delete.preview", threadId: t.threadId, requestId });
    }
    renderPanel();
    panel.root.querySelector<HTMLButtonElement>(".th-delete-actions button")?.focus({ preventScroll: true });
  }

  function showDeletePreview(result: PageThreadDeletePreview): void {
    if (panel?.threadId !== result.threadId || panel.confirming?.kind !== "checking" || panel.confirming.requestId !== result.requestId) return;
    panel.confirming = "preview" in result ? { kind: "ready", preview: result.preview } : { kind: "error", message: result.error };
    renderPanel();
    panel.root.querySelector<HTMLButtonElement>(".th-delete-actions button")?.focus({ preventScroll: true });
  }

  function cancelDeleteConfirm(): void {
    if (!panel) return;
    panel.confirming = null;
    renderPanel();
    panel.root.querySelector<HTMLButtonElement>(".th-trash")?.focus({ preventScroll: true });
  }

  function renderDeleteConfirm(threadId: string, confirm: DeleteConfirmation): HTMLElement {
    const foot = h("div", "th-foot");
    foot.setAttribute("role", "alertdialog");
    foot.setAttribute("aria-label", "Confirm deletion");
    foot.setAttribute("aria-describedby", "th-delete-description");
    const working = opts.thread(threadId)?.state === "running";
    const dialog = confirm.kind === "ready" ? deleteConfirmation(confirm.preview)
      : confirm.kind === "generic" ? {
        text: working ? "Delete this thread and stop its work?" : "Delete this thread?",
        actions: [{ label: working ? "Stop and delete" : "Delete", mode: "keep" as const }],
      } : { text: confirm.kind === "checking" ? "Checking thread changes…" : confirm.message, actions: [] };
    const message = h("span", "th-confirm", dialog.text);
    message.id = "th-delete-description";
    if (confirm.kind === "checking" || confirm.kind === "error") message.setAttribute("role", "status");
    const actions = h("div", "th-delete-actions");
    for (const { label, mode } of dialog.actions) {
      const button = h("button", "th-danger", label);
      button.type = "button";
      button.dataset.choice = mode;
      const queued = confirm.kind === "ready" && confirm.preview === "queued";
      button.disabled = deleting.has(threadId) || (!queued && !connected);
      button.onclick = () => {
        if (panel?.threadId !== threadId || panel.confirming !== confirm || (mode === "commit" && !sourceControlEnabled)) return;
        opts.send({ type: "thread.delete", threadId, mode });
        if (queued) closePanel();
        else cancelDeleteConfirm();
      };
      actions.append(button);
    }
    const cancel = h("button", undefined, "Cancel");
    cancel.type = "button";
    cancel.dataset.choice = "cancel";
    cancel.onclick = cancelDeleteConfirm;
    actions.append(cancel);
    foot.append(message, actions);
    return foot;
  }

  /** A waiting comment's buttons (the sidebar acts on them). */
  function heldActions(turnId: string): HTMLElement {
    const now = h("button", undefined, "Interrupt and send");
    now.type = "button";
    now.dataset.tip = "Stop the current turn and send this comment now";
    now.onclick = () => opts.send({ type: "held.send", turnId });
    const remove = h("button", undefined, "Remove");
    remove.type = "button";
    remove.dataset.tip = "Drop this comment without sending it";
    remove.onclick = () => opts.send({ type: "held.remove", turnId });
    const row = h("div", "th-held");
    row.append(now, remove);
    return row;
  }

  async function copyNativeSession(info: HarnessSessionInfo): Promise<void> {
    if (!opts.copyText || !info.resumeCommand) throw new Error("Clipboard unavailable");
    if (!info.id || !opts.releaseSession) throw new Error("Session unavailable");
    await opts.releaseSession(info.id);
    await opts.copyText(info.resumeCommand);
  }

  /** A conversation entry in the orb's panel: what the user said, then the reply. */
  function renderEntry(e: ConvoEntry, openDetails: Set<string>): HTMLElement {
    const row = h("div", `th-turn${e.note ? " note" : ""}`);
    if (e.user !== null) {
      const user = h("div", "th-msg role-user");
      user.append(h("div", "th-meta", ["You", ...e.badges, ...(e.note ? [e.note] : [])].join(" · ")), h("div", "th-text", e.user));
      if (e.annotation) user.append(drawingPreview(e.annotation));
      if (e.held) user.append(heldActions(e.id));
      row.append(user);
    }
    if (e.assistant || e.who || (e.detail && fullAnswers)) {
      const bot = h("div", "th-msg role-assistant");
      bot.append(h("div", "th-meta", [e.who ?? "Assistant", ...(e.user === null ? e.badges : [])].join(" · ")));
      if (e.assistant) bot.append(assistantText(e.assistant));
      if (e.detail && fullAnswers) {
        const d = h("details");
        d.open = openDetails.has(e.id);
        d.addEventListener("toggle", () => { if (d.open) openDetails.add(e.id); else openDetails.delete(e.id); });
        d.append(h("summary", undefined, "Full answer"), fullAnswer(e.detail));
        bot.append(d);
      }
      row.append(bot);
    }
    if (e.session && opts.continueSession) {
      row.append(sessionActions(e.session, copyNativeSession, async (info) => {
        await opts.continueSession!(info.id!, e.resumeContext ?? e.user ?? undefined);
        panel?.root.querySelector("textarea")?.focus();
      }, true, showSession));
    }
    return row;
  }

  function renderPanel(): void {
    if (!panel) return;
    const p = panel;
    const t = p.threadId === null ? null : opts.thread(p.threadId);
    if (t === undefined) return closePanel();
    const scroll = p.root.querySelector(".th-body")?.scrollTop;
    const active = (layer.getRootNode() as ShadowRoot | Document).activeElement as HTMLElement | null;
    const deleteChoice = active?.closest(".th-foot") && active.dataset.choice;
    const close = h("button", "th-close", "×");
    close.type = "button";
    close.dataset.tip = "Close (Esc)";
    close.setAttribute("aria-label", "Close");
    close.onclick = closePanel;
    const head = h("div", "th-head");
    head.append(h("span", "th-title", t ? displayTitle(t.title) : "Conversation"));
    // The state chip and actions go on the session row when shown, otherwise in the header.
    const controls: HTMLElement[] = [];
    const look = t ? markerLook(t) : opts.orbState();
    const isDeleting = t ? deleting.has(t.threadId) : false;
    const chip = isDeleting ? "deleting…" : look === "asking" ? askingLabel(t) : look === "running" ? "working" : look === "speaking" ? "speaking" : look === "failed" ? "failed" : t ? STATE_LABEL[t.state] : "";
    if (chip) {
      const state = h("span", "th-state", chip);
      state.dataset.state = look;
      controls.push(state);
    }
    if (t) {
      if (t.state === "running") {
        const stop = h("button", "th-stop");
        stop.type = "button";
        stop.disabled = isDeleting || !connected;
        stop.innerHTML = ICON_STOP;
        stop.dataset.tip = "Stop execution; then send your next message";
        stop.setAttribute("aria-label", "Stop execution");
        stop.addEventListener("pointerdown", (e) => e.preventDefault());
        stop.onclick = () => { opts.send({ type: "thread.stop", threadId: t.threadId }); p.form?.focus(); };
        controls.push(stop);
      }
      if (changesStatus && t.state !== "queued") {
        const reason = commitDisabledReason(t.threadId, changesStatus);
        const commit = h("button", "th-commit", "Commit");
        commit.type = "button";
        commit.disabled = reason !== null || isDeleting;
        commit.dataset.tip = reason ?? "Review this thread's changes";
        if (reason !== null) commit.setAttribute("aria-label", `Commit unavailable. ${reason}`);
        commit.onclick = (event) => {
          if (event.isTrusted && !commit.disabled) opts.send({ type: "thread.commit", threadId: t.threadId });
        };
        controls.push(commit);
      }
      const del = h("button", "th-trash");
      del.type = "button";
      del.innerHTML = ICON_TRASH;
      del.dataset.tip = t.state === "queued" ? "Delete this feedback" : isDeleting ? "Deleting this thread…" : !connected ? "Server not connected" : "Delete this thread";
      del.setAttribute("aria-label", "Delete");
      del.disabled = !!p.confirming || isDeleting || (t.state !== "queued" && !connected);
      del.onclick = () => beginDeleteConfirm(t);
      controls.push(del);
    }
    const badge = showSession ? sessionBadge(t ? t.session : conversationSession, copyNativeSession, true) : null;
    let session = badge;
    if (badge && !badge.hidden) {
      session = h("div", "th-session-row");
      session.append(badge, ...controls);
      head.append(close);
    } else head.append(...controls, close);
    const body = h("div", "th-body");
    const firstRender = !p.seen.size;
    let fresh: string | null = null;
    const note = (id: string, row: HTMLElement) => {
      row.dataset.key = id;
      if (p.seen.has(id)) return;
      p.seen.add(id);
      fresh ??= id;
    };
    if (!t) {
      for (const e of entries) {
        const row = renderEntry(e, p.openDetails);
        note(e.id, row);
        body.append(row);
      }
      if (!entries.length) body.append(h("div", "th-empty", "Nothing said yet."));
      p.root.replaceChildren(head, ...(session ? [session] : []), body, p.resize);
      scrollBody(p, body, scroll, firstRender, fresh);
      placePanel();
      return;
    }
    // Follow-ups queued on its element (Instant off) are their own "queued" thread: shown here too, not sent yet.
    const pending = t.state === "queued" ? [] : opts.queued(t.anchor.domPath);
    const waiting = held.filter((c) => c.threadId === t.threadId);
    if (t.messages.length || pending.length || waiting.length) {
      const lastInterrupted = t.interrupted && t.state !== "running" ? t.messages.findLast((m) => m.kind === "interrupted") : undefined;
      for (const m of t.messages) {
        const row = renderMessage(m, p.openDetails);
        if (m === lastInterrupted) row.append(continueAction(t));
        note(m.id, row);
        body.append(row);
      }
      for (const m of pending) {
        const row = renderMessage(m, p.openDetails);
        note(`queued:${m.id}`, row);
        row.classList.add("queued");
        row.querySelector(".th-meta")!.textContent = "You · not sent yet";
        body.append(row);
      }
      // Typed here while a turn was still going: sent when it ends.
      for (const c of waiting) {
        const row = h("div", "th-msg role-user queued");
        row.append(h("div", "th-meta", "You · queued · sends when the current turn ends"), h("div", "th-text", c.text), heldActions(c.turnId));
        note(`held:${c.turnId}`, row);
        body.append(row);
      }
    } else body.append(h("div", "th-empty", "Nothing here yet."));
    if (t.state !== "running" && !t.interrupted && t.canContinue) body.append(continueAction(t));

    // The delete confirmation, right below the header's trash button.
    const foot = p.confirming && renderDeleteConfirm(t.threadId, p.confirming);
    // "Always use the smart model": the router only speaks for it (a spoken turn), a typed one goes straight to it.
    const smart = h("label", "th-smart");
    if (t.state !== "queued") {
      const box = h("input");
      box.type = "checkbox";
      box.checked = !!t.alwaysSmart;
      box.onchange = () => opts.send({ type: "thread.smart", threadId: t.threadId, on: box.checked });
      smart.dataset.tip = "Everything you say or type here is done by the smart model. Spoken requests still get a quick spoken reply first.";
      smart.append(box, "Always use the smart model");
    }
    // The form stays in place (moving it would take the focus and the caret from it).
    const form = p.form!;
    const compose = form.root.parentElement ?? h("div", "th-compose");
    if (!compose.isConnected) { compose.append(form.root); p.root.append(compose); }
    compose.inert = isDeleting;
    for (const c of [...p.root.children]) if (c !== compose && c !== p.resize) c.remove();
    compose.before(head, ...(session ? [session] : []), ...(foot ? [foot] : []), ...(t.summary ? [h("div", "th-summary", stripVoiceCues(t.summary))] : []), body);
    if (smart.childElementCount) compose.after(smart);
    if (!p.resize.isConnected) p.root.append(p.resize);
    if (deleteChoice && foot) (foot.querySelector<HTMLButtonElement>(`[data-choice="${deleteChoice}"]:not(:disabled)`)
      ?? foot.querySelector<HTMLButtonElement>("[data-choice=cancel]"))?.focus({ preventScroll: true });
    scrollBody(p, body, scroll, firstRender, fresh);
    placePanel();
  }

  /** Keeps the body's scroll across a re-render; scrolls to a message that just arrived. */
  function scrollBody(p: NonNullable<typeof panel>, body: HTMLElement, scroll: number | undefined, firstRender: boolean, fresh: string | null): void {
    let goalRow: HTMLElement | null = null;
    if (scroll === undefined || firstRender) {
      body.scrollTop = body.scrollHeight;
      p.goal = null;
    } else {
      body.scrollTop = scroll;
      // A message was added (a turn spoken with the panel open): scroll so it shows, from its top if it's long.
      if (fresh) p.goal = fresh;
      goalRow = p.goal ? [...body.children].find((c) => (c as HTMLElement).dataset.key === p.goal) as HTMLElement ?? null : null;
      const top = goalRow ? Math.min(goalRow.offsetTop - body.offsetTop - 8, body.scrollHeight - body.clientHeight) : 0;
      if (goalRow && top > body.scrollTop + 1) body.scrollTo({ top, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      else p.goal = null;
    }
    // Scrolling by hand gives up the goal.
    const giveUp = () => { p.goal = null; };
    for (const type of ["wheel", "touchstart", "keydown"]) body.addEventListener(type, giveUp, { passive: true });
    body.addEventListener("scrollend", () => {
      if (!goalRow || panel !== p || !goalRow.isConnected) return;
      if (body.scrollTop + 1 >= Math.min(goalRow.offsetTop - body.offsetTop - 8, body.scrollHeight - body.clientHeight)) p.goal = null;
    });
  }

  // Esc and clicks outside the overlay close the panel.
  window.addEventListener("keydown", (e) => {
    if (!panel || drawingPreviewOpen()) return;
    if (panel.confirming && (e.key === "Tab" || e.key === "Enter")) {
      const buttons = [...panel.root.querySelectorAll<HTMLButtonElement>(".th-delete-actions button:not(:disabled)")];
      const focused = (layer.getRootNode() as ShadowRoot | Document).activeElement;
      if (e.key === "Enter" && focused instanceof HTMLButtonElement && buttons.includes(focused)) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) focused.click();
      } else if (e.key === "Tab" && focused === (e.shiftKey ? buttons[0] : buttons.at(-1))) {
        e.preventDefault();
        (e.shiftKey ? buttons.at(-1) : buttons[0])?.focus();
      }
    }
    if (e.key !== "Escape") return;
    if (panel.form && (layer.getRootNode() as ShadowRoot | Document).activeElement === panel.form.field) return; // the field's own handler
    e.preventDefault();
    e.stopPropagation();
    if (panel.confirming) cancelDeleteConfirm(); else closePanel();
  }, true);

  function setConversation(list: ConvoEntry[], session: HarnessSessionInfo | null = null): void {
    entries = list;
    conversationSession = session;
    if (panel?.threadId === null) renderPanel();
  }

  function setHeld(items: HeldComment[]): void {
    held = items;
    if (panel?.threadId) renderPanel();
  }

  function commitDisabledReason(threadId: string, status: NonNullable<PageChangesStatus>): string | null {
    if (status.kind === "unavailable") return status.reason;
    return status.ownedThreadIds.includes(threadId) ? null : "This thread has no uncommitted owned changes";
  }

  function setChangesStatus(status: PageChangesStatus, enabled: boolean): void {
    const before = changesStatus;
    const toggled = sourceControlEnabled !== enabled;
    sourceControlEnabled = enabled;
    changesStatus = enabled ? status : null;
    const threadId = panel?.threadId;
    if (!threadId || !panel) return;
    if (toggled && panel.confirming && opts.thread(threadId)?.state !== "queued") {
      if (enabled) return cancelDeleteConfirm();
      panel.confirming = { kind: "generic" };
      renderPanel();
      return;
    }
    if ((before ? commitDisabledReason(threadId, before) : undefined)
      !== (changesStatus ? commitDisabledReason(threadId, changesStatus) : undefined)) renderPanel();
  }

  function setThreadActions({ deleting: deletingIds, continuing: continuingIds, connected: online }: PageThreads): void {
    deleting = new Set(deletingIds);
    continuing = new Set(continuingIds);
    connected = online ?? true;
  }

  function setDetails(on: boolean): void {
    if (on === details) return;
    details = on;
    if (panel) renderPanel();
  }

  function setSession(on: boolean): void {
    if (on === showSession) return;
    showSession = on;
    if (panel) renderPanel();
  }

  function setFullAnswers(on: boolean): void {
    if (on === fullAnswers) return;
    fullAnswers = on;
    if (panel) renderPanel();
  }

  return {
    get current() { return panel; },
    open: openPanel, central: openCentral, close: closePanel, render: renderPanel, position: placePanel,
    forgetSize: (id: string) => panelSizes.delete(id),
    setThreadActions, showDeletePreview, setChangesStatus,
    setConversation, setHeld, setDetails, setSession, setFullAnswers,
    snapshot: () => panel && ({
      threadId: panel.threadId, draft: panel.form?.snapshot(), details: [...panel.openDetails],
      scroll: panel.root.querySelector(".th-body")?.scrollTop ?? 0,
      size: panelSizes.get(panel.threadId), offset: panel.offset,
    }),
    restore(saved: PanelSnapshot) {
      if (panel || (saved.threadId !== null && !opts.thread(saved.threadId))) return;
      if (saved.size) panelSizes.set(saved.threadId, saved.size);
      if (saved.threadId === null) openCentral(saved);
      else openPanel(saved.threadId, saved);
      const body = layer.querySelector(".th-panel .th-body");
      if (body) body.scrollTop = saved.scroll;
    },
  };
}
