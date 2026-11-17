// Element threads: who hears a finished result (docs/PLAN-threads.md, "Who gets the full result"). Pure.
//
// A finished thread is spoken in full when it's the focused thread (latest lastInteractionAt) or no other thread
// is running; otherwise it gets a one-line reminder and goes pending. Reminders ready together share one line.
import type { ThreadInfo } from "../../shared/threads.ts";

type Brief = Pick<ThreadInfo, "threadId" | "state" | "lastInteractionAt">;

/** The thread the user dealt with last (max lastInteractionAt), or null when there are none. */
export function focusedThreadId(threads: readonly Brief[]): string | null {
  let best: Brief | null = null;
  for (const t of threads) if (!best || t.lastInteractionAt > best.lastInteractionAt) best = t;
  return best?.threadId ?? null;
}

/** How a thread that just finished is announced. */
export function finishMode(threadId: string, threads: readonly Brief[]): "full" | "reminder" {
  if (focusedThreadId(threads) === threadId) return "full";
  return threads.some((t) => t.threadId !== threadId && t.state === "running") ? "reminder" : "full";
}

const isRo = (language: string | undefined) => language === "ro";

/** "a", "a and b", "a, b and c" (Romanian: "și"). */
export function joinTitles(titles: readonly string[], language?: string): string {
  const and = isRo(language) ? "și" : "and";
  if (titles.length <= 1) return titles[0] ?? "";
  return `${titles.slice(0, -1).join(", ")} ${and} ${titles[titles.length - 1]}`;
}

/** The reminder for one or more finished threads (one spoken line). */
export function reminderText(titles: readonly string[], language?: string): string {
  const uniq = [...new Set(titles)];
  if (isRo(language)) {
    return uniq.length <= 1
      ? `O sarcină anterioară pentru ${uniq[0] ?? "un element"} s-a terminat. Vrei să-ți spun despre ea?`
      : `Sarcinile pentru ${joinTitles(uniq, language)} s-au terminat. Vrei să-ți spun despre ele?`;
  }
  return uniq.length <= 1
    ? `An earlier task on ${uniq[0] ?? "an element"} finished. Want me to tell you about it?`
    : `The tasks on ${joinTitles(uniq, language)} finished. Want to hear about them?`;
}

/**
 * A page as it's said aloud: the last meaningful part of its path ("…/pricing.html" → "the pricing page"), the
 * home page for "/" or an index.
 */
export function pageName(url: string, language?: string): string {
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split(/[?#]/)[0] ?? "";
  }
  const parts = path.split("/").map((p) => decodeURIComponent(p).replace(/\.[a-z0-9]+$/i, "")).filter(Boolean);
  const name = parts.reverse().find((p) => !/^(index|default|home)$/i.test(p) && !/^[0-9a-f-]{6,}$/i.test(p) && !/^\d+$/.test(p));
  const words = name?.replace(/[-_+.]+/g, " ").trim();
  if (isRo(language)) return words ? `pagina ${words}` : "pagina principală";
  return words ? `the ${words} page` : "the home page";
}

/** A thread finished while the user was on another page: the full result waits until they're back there. */
export function awayText(title: string, pageUrl: string, language?: string): string {
  const page = pageName(pageUrl, language);
  return isRo(language)
    ? `Sarcina pentru ${title} de pe ${page} s-a terminat. Îți spun despre ea când te întorci acolo, sau întreabă-mă.`
    : `The task on ${title} on ${page} finished. I'll tell you about it when you're back there, or just ask.`;
}

/** Spoken when a thread's run failed. */
export function failureText(title: string, language?: string): string {
  return isRo(language) ? `Sarcina pentru ${title} nu a reușit.` : `The task on ${title} failed.`;
}

/** Central log line when a thread starts and finishes ("Started a task on the red button: …"). */
export function startedLine(title: string, request: string): string {
  return `Started a task on ${title}: ${request}`;
}
export function finishedLine(title: string, spoken: string): string {
  const name = title.replace(/^the\s+/i, "");
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} task finished: ${spoken}`;
}

/** The system follow-up for files another overlapping run also changed. */
export function reconcileText(files: readonly string[]): string {
  const list = joinTitles(files);
  return files.length === 1
    ? `${list} was also changed by another task meanwhile: re-read it and check your change is intact.`
    : `${list} were also changed by another task meanwhile: re-read them and check your changes are intact.`;
}

/** Floor priority: the focused thread's result > other results > central lines > reminders. Higher speaks first. */
export function linePriority(kind: "result" | "central" | "reminder", focused: boolean): number {
  if (kind === "result") return focused ? 3 : 2;
  return kind === "central" ? 1 : 0;
}
