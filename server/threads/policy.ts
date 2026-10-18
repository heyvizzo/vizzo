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
