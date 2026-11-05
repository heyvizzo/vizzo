// Queued feedback (Instant off in the browser toolbar): a turn's messages to the server are recorded instead of sent,
// and replayed later as a normal turn with the sidebar's settings at that moment. Recorded times are on the client
// clock of the recording; the replay shifts them so the turn is released "now" (latency marks stay meaningful).
import type { DrawingAnnotation } from "../../shared/annotations.ts";
import { anchorTitle, drawingAnchor, inferAnchor } from "../../shared/anchor.ts";
import { computeRests, resolvePointing, type PointingLanguage } from "../../shared/pointing.ts";
import type { ClientMsg, CursorSample, PageClick, PageEvents, Word } from "../../shared/protocol.ts";
import type { ThreadAnchor, ThreadInfo } from "../../shared/threads.ts";

export type TurnMsg = Extract<ClientMsg, { type: "turn.start" | "cursor.samples" | "turn.audioStart" | "turn.context" | "turn.release" }>;
export type Recorded = { msg: TurnMsg } | { pcm: Int16Array<ArrayBuffer> };

/** What the toolbar shows (relayed by electron/main.ts). */
export interface QueueState {
  instant: boolean;
  count: number;
  sending: boolean;
}

const shiftSample = (s: CursorSample, d: number): CursorSample => ({ ...s, t: s.t + d });

function shiftPage(p: PageEvents, d: number): PageEvents {
  return {
    clicks: p.clicks.map((c) => ({ ...c, t: c.t + d, tEnd: c.tEnd + d, times: c.times.map((t) => t + d) })),
    preselected: p.preselected && { ...p.preselected, t: p.preselected.t + d },
    highlights: p.highlights.map((h) => ({ ...h, t: h.t + d, tStart: h.tStart + d })),
  };
}

/** The message with every client time moved by `d` ms. */
export function shiftMsg(msg: TurnMsg, d: number): TurnMsg {
  switch (msg.type) {
    case "turn.start": return { ...msg, tPress: msg.tPress + d };
    case "cursor.samples": return { ...msg, samples: msg.samples.map((s) => shiftSample(s, d)) };
    case "turn.audioStart": return { ...msg, tAudioStart: msg.tAudioStart + d };
    case "turn.context": {
      const { type, turnId, ...page } = msg;
      return { type, turnId, ...shiftPage(page, d) };
    }
    case "turn.release": return { ...msg, tRelease: msg.tRelease + d };
  }
}

/** Duration of the recorded speech (press → release), ms. */
export function recordedMs(rec: Recorded[]): number {
  let press: number | undefined;
  let release: number | undefined;
  for (const r of rec) {
    if (!("msg" in r)) continue;
    if (r.msg.type === "turn.start") press = r.msg.tPress;
    if (r.msg.type === "turn.release") release = r.msg.tRelease;
  }
  return press !== undefined && release !== undefined ? Math.max(0, release - press) : 0;
}

/** Thread ids of queued feedback on the page (never sent to the server). */
export const QUEUED_PREFIX = "queued:";
export const isQueuedId = (threadId: string) => threadId.startsWith(QUEUED_PREFIX);

/** The recorded audio (PCM16 24 kHz), in order. */
export function recordedPcm(rec: Recorded[]): Int16Array<ArrayBuffer> {
  const parts = rec.flatMap((r) => ("pcm" in r ? [r.pcm] : []));
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * The element a queued turn is about: where the user last clicked, else where the cursor rested longest while they
 * talked, else the last element under it. Before it's transcribed the whole recording counts as speech; with `words`
 * (an on-device transcript, made when it was queued) the rests and pointing words come from them, like a sent turn.
 * Null without a page or an element.
 */
export function queuedAnchor(rec: Recorded[], words?: Word[], languages?: readonly PointingLanguage[]): ThreadAnchor | null {
  let start: Extract<TurnMsg, { type: "turn.start" }> | undefined;
  let tAudioStart: number | undefined;
  let tRelease: number | undefined;
  const samples: CursorSample[] = [];
  const clicks: PageClick[] = [];
  for (const r of rec) {
    if (!("msg" in r)) continue;
    const m = r.msg;
    if (m.type === "turn.start") start = m;
    else if (m.type === "turn.audioStart") tAudioStart = m.tAudioStart;
    else if (m.type === "turn.release") tRelease = m.tRelease;
    else if (m.type === "cursor.samples") samples.push(...m.samples);
    else if (m.type === "turn.context") clicks.push(...m.clicks);
  }
  if (start?.annotation) return drawingAnchor(start.annotation);
  if (!start?.pageUrl) return null;
  const from = tAudioStart ?? start.tPress;
  if (words?.length) {
    const pointing = resolvePointing(words, from, samples, undefined, languages);
    return inferAnchor({ words, pointing, rests: computeRests(words, from, samples, pointing), samples, pageUrl: start.pageUrl, clicks });
  }
  const whole = tRelease !== undefined && tRelease > from ? [{ text: "…", start: 0, end: (tRelease - from) / 1000 }] : [];
  return inferAnchor({ words: whole, pointing: [], rests: computeRests(whole, from, samples), samples, pageUrl: start.pageUrl, clicks });
}

/** One queued turn on an element, as queuedThreads groups it. */
export interface QueuedItem { turnId: string; anchor: ThreadAnchor; text: string; at: number; annotation?: DrawingAnnotation }

/** Same element on the same page: queued feedback on it is one thread. */
export const anchorKey = (a: ThreadAnchor) => `${a.pageUrl}\n${a.domPath}`;

/**
 * Queued turns as threads for the page overlay: one per element (its marker, state "queued", and panel, where Delete
 * drops all of them), with the first turn as the request and the rest as follow-ups, in queue order.
 */
export function queuedThreads(items: QueuedItem[]): ThreadInfo[] {
  const groups = new Map<string, QueuedItem[]>();
  for (const it of items) {
    const key = anchorKey(it.anchor);
    const g = groups.get(key);
    if (g) g.push(it);
    else groups.set(key, [it]);
  }
  return [...groups.values()].map((g) => {
    const first = g[0]!;
    const threadId = QUEUED_PREFIX + first.turnId;
    const last = g[g.length - 1]!;
    return {
      threadId, pageUrl: first.anchor.pageUrl, anchor: first.anchor, title: anchorTitle(first.anchor), state: "queued", intent: "task",
      summary: "Not sent yet. The arrow next to the address bar sends it, with the sidebar's settings then.",
      unread: false, awaitingReply: false, createdAt: first.at, lastInteractionAt: last.at,
      messages: g.map((it, i) => ({ id: `${QUEUED_PREFIX}${it.turnId}:request`, turnId: it.turnId, at: it.at, role: "user", kind: i ? "followup" : "request", text: it.text, ...(it.annotation ? { annotation: it.annotation } : {}) })),
    };
  });
}
