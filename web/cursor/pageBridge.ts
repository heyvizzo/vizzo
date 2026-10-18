// The Electron app's browser pane, seen from the chat sidebar. The page runs in its own process, so its pointer
// samples, clicks and highlights are recorded there (electron/page-preload.ts) and relayed by electron/main.ts.
// Each process has its own performance clock: times cross the bridge as epoch ms (performance.timeOrigin + t)
// and each side converts to and from its own clock.
import type { CursorRest, CursorSample, ElementDetails, PageEvents, PointingTarget } from "../../shared/protocol.ts";
import type { ThreadInfo, ThreadSay } from "../../shared/threads.ts";

/** Chat → page. `start.t` is epoch ms. */
export type PageCmd =
  | { type: "start"; t: number }
  | { type: "stop" }
  | { type: "clear" }
  | { type: "overlay"; targets: PointingTarget[]; rests: CursorRest[]; visible: string[] }
  /** Element threads on this page (already filtered by normalizePageUrl): draw/update their markers. */
  | { type: "threads"; threads: ThreadInfo[] }
  /** A thread's spoken line: show a bubble from its marker. `ended`: its audio finished (the fade may start). */
  | { type: "bubble"; say: ThreadSay; ended: boolean }
  /** The conversation orb (the page as a whole): its state, and where it was dragged to (null: the default spot). */
  | { type: "orb"; state: OrbState; pos: OrbPos | null }
  /** The conversation as the sidebar shows it, for the orb's panel. */
  | { type: "conversation"; entries: ConvoEntry[] }
  /** Turn released: draw a provisional marker on the element under the pointer until `decision.threadId` arrives. */
  | { type: "provisional"; turnId: string } | { type: "provisional.clear"; turnId: string }
  /**
   * Settings toggles, off until the sidebar says otherwise. outlines (debugging): draw the `overlay` outlines.
   * hover: the comment mode's hover box on the element under the pointer, outside the mode too.
   */
  | { type: "debug"; outlines: boolean; hover: boolean }
  /** The comment bubble (web/cursor/commentOverlay.ts): Send or Add to list, dictation running, its live words. */
  | { type: "comment.state"; state: CommentState }
  /** Dictated words to insert at the comment field's caret. */
  | { type: "comment.insert"; text: string };

/** The orb's look: running while a turn or task that isn't an element thread's is being worked on. */
export type OrbState = "idle" | "listening" | "running" | "asking";

/** The orb's center as fractions of the viewport (kept in place, relatively, as the window resizes). */
export interface OrbPos { x: number; y: number }

/** One entry of the conversation (web/chat/main.ts conversationEntries): a turn, a background task, or a line said outside a turn. */
export interface ConvoEntry {
  id: string;
  /** What the user said (null: not a turn). */
  user: string | null;
  /** The assistant's reply ("" while there's none). */
  assistant: string;
  /** Whose line it is, when it isn't a turn's reply ("The red button · index.html", "Background task · 12 s"). */
  who?: string;
  /** The decision's badges and the turn's tags ("question", "~10 s", "interrupted"). */
  badges: string[];
  /** The solver's detailed answer. */
  detail?: string;
  /** Shown dimmed: "not sent yet" (Instant off). */
  note?: string;
}

export interface CommentState {
  /** Instant feedback is on: the bubble's button sends now (off: adds it to the list). */
  instant: boolean;
  /** Dictating into the bubble (Record, Shift or always-listen). */
  recording: boolean;
  /** Stopped dictating; the words are on their way (the bubble mustn't close: they'd be dropped). */
  transcribing: boolean;
  /** What's been heard so far, shown under the field until the final words are inserted. */
  partial: string;
  /** A turn is being recorded (always-listen, Shift or the talk button with no form open): the forms show it and can't be typed in. */
  listening?: boolean;
}

/** Page → chat: the comment bubble. `draft`: one is open (Shift and always-listen dictate into it instead of a turn). */
export type PageCommentAction =
  | { type: "comment.draft"; open: boolean }
  | { type: "comment.record"; on: boolean }
  /** Send the comment (or add it to the list). `sample`: the clicked element, `t` in epoch ms. */
  | { type: "comment.send"; text: string; sample: CursorSample };

export function isPageCommentAction(m: unknown): m is PageCommentAction {
  const a = m as { type?: unknown; open?: unknown; on?: unknown; text?: unknown; sample?: { elementPath?: unknown } } | null;
  if (!a) return false;
  if (a.type === "comment.draft") return typeof a.open === "boolean";
  if (a.type === "comment.record") return typeof a.on === "boolean";
  return a.type === "comment.send" && typeof a.text === "string" && typeof a.sample?.elementPath === "string";
}

/** Page → chat: one document's events for the current turn (epoch ms). `final`: the reply to a stop. */
export interface PageEventsMsg { doc: string; events: PageEvents; final: boolean }

/** Page → chat: the user acted on a thread in the page overlay (opened its panel / confirmed its deletion). Sent on as the ClientMsg. */
export type PageThreadAction = { type: "thread.focus"; threadId: string } | { type: "thread.delete"; threadId: string };

export function isPageThreadAction(m: unknown): m is PageThreadAction {
  const a = m as Partial<PageThreadAction> | null;
  return !!a && (a.type === "thread.focus" || a.type === "thread.delete") && typeof a.threadId === "string" && !!a.threadId;
}

/** Page → chat: the orb was dragged (sent when it's dropped). Relayed on the thread channel, not sent to the server. */
export type PageOrbAction = { type: "orb.move"; pos: OrbPos };

export function isPageOrbAction(m: unknown): m is PageOrbAction {
  const a = m as { type?: unknown; pos?: { x?: unknown; y?: unknown } } | null;
  return !!a && a.type === "orb.move" && typeof a.pos?.x === "number" && typeof a.pos.y === "number"
    && Number.isFinite(a.pos.x) && Number.isFinite(a.pos.y);
}

/** What the sidebar's preload exposes as `window.shell.page`. The thread members exist only in the Electron app. */
export interface PageBridge {
  send(cmd: PageCmd): void;
  onSamples(cb: (samples: CursorSample[]) => void): void;
  onEvents(cb: (msg: PageEventsMsg) => void): void;
  /** The browser pane's URL: now, and whenever it changes or a document there (re)loads (so its threads are sent again). */
  getUrl?(): Promise<string | null>;
  onUrl?(cb: (url: string) => void): void;
  /** Load a URL in the browser pane (a thread on another page). */
  navigate?(url: string): void;
  /** Open a thread's panel on the page (and scroll its marker into view). */
  openThread?(threadId: string): void;
  onThreadAction?(cb: (action: PageThreadAction | PageOrbAction) => void): void;
  /** The comment bubble's actions (comment mode, from the toolbar's pointer button). */
  onComment?(cb: (action: PageCommentAction) => void): void;
}

/** Wait this long for the page's events after a stop (the page may be mid-navigation and never answer). */
export const STOP_TIMEOUT_MS = 250;
const KEEP_MS = 120_000;

export function shiftSamples(samples: readonly CursorSample[], dt: number): CursorSample[] {
  return samples.map((s) => ({ ...s, t: s.t + dt }));
}

export function shiftPageEvents(ev: PageEvents, dt: number): PageEvents {
  return {
    clicks: ev.clicks.map((c) => ({ ...c, t: c.t + dt, tEnd: c.tEnd + dt, times: c.times.map((x) => x + dt) })),
    preselected: ev.preselected && { ...ev.preselected, t: ev.preselected.t + dt },
    highlights: ev.highlights.map((h) => ({ ...h, tStart: h.tStart + dt, t: h.t + dt })),
  };
}

/** One turn can span several documents (a click on a link navigates): their events in order, the first's preselection. */
export function mergePageEvents(list: readonly PageEvents[]): PageEvents {
  return {
    clicks: list.flatMap((e) => e.clicks),
    preselected: list[0]?.preselected ?? null,
    highlights: list.flatMap((e) => e.highlights),
  };
}

export interface RemotePage {
  /** Samples with from ≤ t ≤ to (chat clock). */
  range(from: number, to?: number): CursorSample[];
  /** The latest details the page sent for the element at this CSS path. */
  details(elementPath: string): ElementDetails | undefined;
  /** Begin recording a turn at chat time `tFrom`. */
  start(tFrom: number): void;
  /** End the turn and return its events (chat clock); resolves after the page answers or STOP_TIMEOUT_MS. */
  stop(): Promise<PageEvents>;
  /** Stop recording, unpaint the page's highlights and drop its selection. */
  clear(): void;
  /** Draw the turn's pointing targets and cursor rests on the page (empty lists remove the overlay). */
  overlay(targets: PointingTarget[], rests: CursorRest[], visible: string[]): void;
}

export function createRemotePage(bridge: PageBridge, origin = performance.timeOrigin, stopTimeoutMs = STOP_TIMEOUT_MS): RemotePage {
  const samples: CursorSample[] = [];
  const details = new Map<string, ElementDetails>();
  let docs = new Map<string, PageEvents>();
  let recording = false;
  let answered: (() => void) | null = null;

  bridge.onSamples((batch) => {
    samples.push(...shiftSamples(batch, -origin));
    for (const s of batch) if (s.elementPath && s.details) details.set(s.elementPath, s.details);
    if (details.size > 2000) details.delete(details.keys().next().value!);
    const last = samples[samples.length - 1];
    if (last && samples.length > 8000) samples.splice(0, samples.findIndex((s) => last.t - s.t <= KEEP_MS));
  });
  bridge.onEvents((msg) => {
    if (!recording) return;
    docs.set(msg.doc, shiftPageEvents(msg.events, -origin));
    if (msg.final) answered?.();
  });

  return {
    range: (from, to = Infinity) => samples.filter((s) => s.t >= from && s.t <= to),
    details: (path) => details.get(path),
    start(tFrom) {
      docs = new Map();
      recording = true;
      bridge.send({ type: "start", t: tFrom + origin });
    },
    async stop() {
      await new Promise<void>((resolve) => {
        answered = resolve;
        setTimeout(resolve, stopTimeoutMs);
        bridge.send({ type: "stop" });
      });
      answered = null;
      recording = false;
      return mergePageEvents([...docs.values()]);
    },
    clear() {
      recording = false;
      answered?.();
      bridge.send({ type: "clear" });
    },
    overlay: (targets, rests, visible) => bridge.send({ type: "overlay", targets, rests, visible }),
  };
}
