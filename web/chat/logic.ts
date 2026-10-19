// Pure helpers for the chat page: decision badges, estimates, job labels, the solver detail extraction,
// and a rough "is audio still playing" estimate. No DOM here (unit-tested in logic.test.ts).
import type { EngineState, JobInfo, RouteIntent } from "../../shared/protocol.ts";
import { STT_LABELS, STT_PINNED_LANGUAGES, type SpeechLanguage, type SttModel } from "../../shared/config.ts";
import { normalizePageUrl, type ThreadInfo } from "../../shared/threads.ts";

/** Seconds → "~8 s", "~1.5 min", "~2 min", "~1 h". null/invalid → "". */
export function fmtEstimate(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s) || s < 0) return "";
  if (s < 1) return "<1 s";
  if (s < 60) return `~${Math.round(s)} s`;
  if (s < 3600) {
    const m = s / 60;
    return `~${m < 10 ? trimNum(Math.round(m * 2) / 2) : Math.round(m)} min`;
  }
  return `~${trimNum(Math.round((s / 3600) * 2) / 2)} h`;
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Elapsed ms → "0 s", "42 s", "1 min 14 s", "12 min". */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m >= 10 || r === 0 ? `${m} min` : `${m} min ${r} s`;
}

export interface DecisionLike { intent: RouteIntent; estimateS: number | null; background: boolean }

/** Badge texts for a turn's decision, e.g. ["task", "~2 min", "working in background"]. */
export function decisionBadges(d: DecisionLike): string[] {
  if (d.intent === "clarify") return ["asking you a follow-up"];
  if (d.intent === "answer") return ["direct answer"];
  const out: string[] = [d.intent];
  const est = fmtEstimate(d.estimateS);
  if (est) out.push(est);
  if (d.background) out.push("working in background");
  return out;
}

/** The solver streams `SPOKEN: …` + blank line + details. Returns the details part (the spoken line is said aloud). */
export function detailOf(solverText: string): string {
  if (!/^\s*SPOKEN:/i.test(solverText)) return solverText;
  const i = solverText.search(/\n\s*\n/);
  return i < 0 ? "" : solverText.slice(i).trim();
}

/** Drop a leading `SPOKEN:` prefix from a spoken line. */
export function spokenOf(text: string): string {
  return text.replace(/^\s*SPOKEN:\s*/i, "").trim();
}

/** Headline for a job card. */
export function jobHeadline(job: Pick<JobInfo, "state" | "intent" | "elapsedMs">, elapsedMs: number): string {
  const kind = job.intent === "question" ? "question" : "task";
  if (job.state === "running") return `Background ${kind} · running ${fmtElapsed(elapsedMs)}`;
  const took = job.elapsedMs ?? elapsedMs;
  if (job.state === "done") return `Background ${kind} · ${fmtElapsed(took)}`;
  if (job.state === "stopped") return `Background ${kind} · stopped by you`;
  return `Failed after ${fmtElapsed(took)}`;
}

/** A job's question shortened for its marker: whitespace collapsed, cut at a word boundary, with "…". */
export function markerLabel(question: string, max = 40): string {
  const q = question.trim().replace(/\s+/g, " ");
  if (q.length <= max) return q;
  const cut = q.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** "1 task running", "3 tasks running", "" for none. */
export function runningLabel(n: number): string {
  return n <= 0 ? "" : `${n} task${n === 1 ? "" : "s"} running`;
}

const BYTES_PER_SECOND = 24000 * 2; // PCM16 mono 24 kHz

/**
 * Estimates whether queued audio is still audible: each push extends a "playing until" time by the chunk's
 * duration (from now, or from the end of what's already queued). Times are performance.now() ms.
 */
export class PlaybackClock {
  private until = 0;
  push(bytes: number, now: number): void {
    this.until = Math.max(this.until, now) + (bytes / BYTES_PER_SECOND) * 1000;
  }
  reset(): void {
    this.until = 0;
  }
  /** What was playing was cut off (audio.cut): nothing after it had come yet, so playback ends now. */
  cut(now: number): void {
    this.until = Math.min(this.until, now);
  }
  isPlaying(now: number): boolean {
    return now < this.until;
  }
  remainingMs(now: number): number {
    return Math.max(0, this.until - now);
  }
}

// ── element threads ──

/** The turn's reply bubble stays up until answered: a follow-up question, or a reply that ends with "?". */
export function replyNeedsReply(intent: RouteIntent | undefined, text: string): boolean {
  return intent === "clarify" || /\?\s*["'”’)]*\s*$/.test(text);
}

/** The threads on the page at `url` (null: none). */
export function threadsOnPage(threads: Iterable<ThreadInfo>, url: string | null): ThreadInfo[] {
  if (!url) return [];
  const page = normalizePageUrl(url);
  return [...threads].filter((t) => t.pageUrl === page);
}

export interface ThreadGroup { pageUrl: string; current: boolean; threads: ThreadInfo[] }

/** When the thread last had something happen in it: its newest message, else its creation. Opening it doesn't count. */
export function lastActivityAt(t: ThreadInfo): number {
  return Math.max(t.createdAt, ...t.messages.map((m) => m.at));
}

/**
 * Threads grouped by page: the current page first, then the most recently active; newest activity first within a page.
 * Sorted by activity, not lastInteractionAt, so opening a thread (which bumps that, to focus it) doesn't reorder the list.
 */
export function groupThreads(threads: Iterable<ThreadInfo>, url: string | null): ThreadGroup[] {
  const current = url ? normalizePageUrl(url) : null;
  const groups = new Map<string, ThreadInfo[]>();
  for (const t of threads) groups.set(t.pageUrl, [...(groups.get(t.pageUrl) ?? []), t]);
  const latest = (list: ThreadInfo[]) => Math.max(...list.map(lastActivityAt));
  return [...groups.entries()]
    .map(([pageUrl, list]) => ({ pageUrl, current: pageUrl === current, threads: list.sort((a, b) => lastActivityAt(b) - lastActivityAt(a)) }))
    .sort((a, b) => Number(b.current) - Number(a.current) || latest(b.threads) - latest(a.threads));
}

/** "84 MB", "1.4 GB" (resident memory). */
export function fmtBytes(n: number): string {
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/**
 * What the Settings page says under Voice / Speech about the selected model's on-device engine (`engine`: its id;
 * null: a cloud model, nothing to load). `pending`: the switch was just sent and the server hasn't listed it yet.
 */
export function engineStatus(engine: string | null, kind: "tts" | "stt", engines: readonly EngineState[], pending = false):
  { state: "loading" | "ready" | "error" | "idle"; text: string } | null {
  if (!engine) return null;
  const e = engines.find((x) => x.kind === kind && x.engine === engine);
  if (!e) return pending ? { state: "loading", text: "Loading…" } : { state: "idle", text: "Not loaded: it loads on the first turn." };
  const ram = e.ramBytes ? ` · ${fmtBytes(e.ramBytes)} RAM` : "";
  if (e.state === "loading") return { state: "loading", text: `Loading ${e.label}…${ram}` };
  if (e.state === "error") return { state: "error", text: `Couldn't load ${e.label}: ${e.error ?? "unknown error"}` };
  return { state: "ready", text: `${e.label} loaded${e.loadMs !== undefined ? ` in ${(e.loadMs / 1000).toFixed(1)} s` : ""}${ram}` };
}

/** "localhost:5173/pricing.html?plan=pro" (no scheme, no trailing slash on the root); file URLs by their name. */
export function pageLabel(pageUrl: string): string {
  try {
    const u = new URL(pageUrl);
    if (u.protocol === "file:") return decodeURIComponent(u.pathname.split("/").pop() || u.pathname);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.host}${path}${u.search}`;
  } catch {
    return pageUrl;
  }
}

/** Why the chosen speech model won't follow the chosen language, or undefined when it does (or the language is auto). */
export function sttLanguageWarning(model: SttModel, language: SpeechLanguage): string | undefined {
  if (language === "auto" || STT_PINNED_LANGUAGES[model].includes(language)) return undefined;
  const name = language === "ro" ? "Romanian" : "English";
  const ok = (Object.keys(STT_PINNED_LANGUAGES) as SttModel[]).filter((m) => STT_PINNED_LANGUAGES[m].includes(language)).map((m) => STT_LABELS[m]);
  const why = STT_PINNED_LANGUAGES[model].length ? `doesn't transcribe ${name} reliably` : "ignores the Language setting and may transcribe in another language";
  return `${STT_LABELS[model]} ${why}. ${name} works with ${ok.join(", ")}.`;
}
