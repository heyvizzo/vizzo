/** Used by the sidebar and Electron's isolated-page bridge. Resolves only after the native writer closes. */
export async function prepareSessionResume(sessionId: string, base = ""): Promise<void> {
  await sessionRequest("release", sessionId, base);
}

/** Make this saved task's native context the main conversation's next session. */
export async function continueSession(sessionId: string, base = "", context?: string): Promise<void> {
  await sessionRequest("continue", sessionId, base, context);
}

async function sessionRequest(action: "release" | "continue", sessionId: string, base: string, context?: string): Promise<void> {
  const response = await fetch(`${base}/api/sessions/${action}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, context }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || (action === "release" ? "Couldn't release the session for terminal resume." : "Couldn't continue this task."));
  }
}
