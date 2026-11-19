import type { ThreadMessage } from "../../shared/threads.ts";

const MAX_MESSAGES = 8;
const MAX_MESSAGE_TEXT = 600;
const MAX_THREAD_TEXT = 2_400;

export interface CommitContextMessage {
  kind: "request" | "followup" | "correction" | "result" | "summary";
  text: string;
}

function capText(text: string, limit: number): string {
  const clean = text.replaceAll("\0", "").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

/** Keep the most recent meaningful messages, presented in chronological order. */
function recentMessages<T>(items: readonly T[], toMessage: (item: T) => CommitContextMessage | undefined): CommitContextMessage[] {
  const messages: CommitContextMessage[] = [];
  let remaining = MAX_THREAD_TEXT;
  for (let i = items.length - 1; i >= 0 && messages.length < MAX_MESSAGES && remaining > 0; i--) {
    const message = toMessage(items[i]!);
    if (!message) continue;
    const text = capText(message.text, Math.min(MAX_MESSAGE_TEXT, remaining));
    if (!text) continue;
    messages.push({ kind: message.kind, text });
    remaining -= text.length;
  }
  return messages.reverse();
}

export function threadMessageContext(messages: readonly ThreadMessage[]): CommitContextMessage[] {
  return recentMessages(messages, (message) => {
    const { role, kind, text, detail, turnId } = message;
    if (role === "user" && (kind === "request" || kind === "followup" || kind === "correction")) {
      // Older retained drawing requests can carry a generated attachment note appended to the user's words.
      return { kind, text: text.split("\n\n[Drawing preview expired from retained history]", 1)[0]! };
    }
    // Reconcile finishes with a result too, but its turnId is null.
    if (role === "assistant" && kind === "result" && turnId !== null) {
      const result = detail?.trim().replace(/^\**SPOKEN:\**\s*/i, "") || text;
      if (!/^(?:done|completed|ok(?:ay)?|all set)[.!]*$/i.test(result.trim())) return { kind, text: result };
    }
  });
}

/** Ledger records written before transcript snapshots retain only requests and the last summary. */
export function closedMessageContext({ messageContext, requests, summary }: {
  messageContext?: readonly CommitContextMessage[];
  requests: readonly string[];
  summary?: string;
}): readonly CommitContextMessage[] {
  if (messageContext?.length) return recentMessages(messageContext, (message) => message);
  return recentMessages([...requests.slice(-MAX_MESSAGES).map((text) => ({ kind: "request" as const, text })),
    ...(summary ? [{ kind: "summary" as const, text: summary }] : [])], (message) => message);
}
