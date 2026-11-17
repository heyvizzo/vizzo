import { conversationSessions } from "./centralSession.ts";
import { threadStore } from "./threads/store.ts";

/** Wait until Vizzo has given up the native writer, without interrupting any request. */
export async function releaseSessionForResume(sessionId: string): Promise<void> {
  const store = threadStore();
  const handles = [...conversationSessions(), ...store.list().map((t) => store.get(t.threadId)?.handle)];
  const matches = handles.filter((h) => h?.session?.()?.id === sessionId);
  if (!matches.length) throw new Error("This session is no longer available in Vizzo.");
  for (const handle of matches) {
    if (!handle?.release) throw new Error("This session cannot be released for terminal resume.");
    await handle.release();
  }
}
