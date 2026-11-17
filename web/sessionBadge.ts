import { LLM_PROVIDER_LABELS } from "../shared/config.ts";
import type { HarnessSessionInfo } from "../shared/harnessSession.ts";

export const SESSION_BADGE_CSS = `
.session-info { min-width: 0; padding: 0 12px 8px; color: var(--ui-muted, var(--muted)); font: 10.5px/1.5 ui-monospace, monospace; }
.session-info .session-badge { display: block; max-width: 100%; box-sizing: border-box; padding: 3px 6px; text-align: left; font: inherit; color: inherit; background: transparent; border: 1px solid var(--ui-line, var(--line)); border-radius: 5px; white-space: normal; overflow-wrap: anywhere; cursor: pointer; }
.session-info .session-badge:hover { color: var(--ui-accent, var(--accent)); border-color: currentColor; }
.session-info .session-badge:focus-visible { outline: 2px solid var(--ui-accent, var(--accent)); outline-offset: 2px; }
.session-copy-status:empty { display: none; }
.session-copy-status { display: block; }
.session-actions { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; }
.session-actions[hidden], .session-continue-status:empty { display: none; }
.session-actions .session-info { padding: 0; }
.session-continue { padding: 4px 8px; border: 1px solid var(--ui-line, var(--line)); border-radius: 5px; background: transparent; color: var(--ui-accent, var(--accent)); font: inherit; cursor: pointer; }
.session-continue:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.session-continue-status { color: var(--ui-muted, var(--muted)); font-size: 11px; }
`;

/** Shared by the sidebar and the isolated page overlay (which supplies native clipboard access). */
export function sessionBadge(
  session: HarnessSessionInfo | null | undefined,
  copy: (session: HarnessSessionInfo) => Promise<void>,
  overlay = false,
): HTMLElement {
  const root = document.createElement("div");
  root.className = "session-info";
  if (!session) { root.hidden = true; return root; }
  const label = `${LLM_PROVIDER_LABELS[session.provider]} · ${session.id ?? "starting…"}`;
  if (!session.resumeCommand) { root.textContent = label; return root; }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "session-badge";
  button.textContent = label;
  button.setAttribute("aria-label", `${label}. Click to copy the resume command`);
  if (overlay) button.dataset.tip = "Click to copy the resume command";
  else button.title = "Click to copy the resume command";
  const status = document.createElement("span");
  status.className = "session-copy-status";
  status.setAttribute("role", "status");
  button.onclick = async () => {
    button.disabled = true;
    status.textContent = "Preparing resume command…";
    try {
      await copy(session);
      status.textContent = "Resume command copied";
    } catch {
      status.textContent = "Couldn't copy. Click to try again.";
    } finally {
      button.disabled = false;
    }
  };
  root.append(button, status);
  return root;
}

/** Completed task controls: normal in-app continuation plus the native session badge in debugging details. */
export function sessionActions(
  session: HarnessSessionInfo | undefined,
  copy: (session: HarnessSessionInfo) => Promise<void>,
  resume: (session: HarnessSessionInfo) => Promise<void>,
  overlay = false,
  details = true,
): HTMLElement {
  const root = document.createElement("div");
  root.className = "session-actions";
  if (!session?.id) { root.hidden = true; return root; }
  if (details) root.append(sessionBadge(session, copy, overlay));
  const button = document.createElement("button");
  button.type = "button";
  button.className = "session-continue";
  button.textContent = "Continue in Vizzo";
  const status = document.createElement("span");
  status.className = "session-continue-status";
  status.setAttribute("role", "status");
  button.onclick = async () => {
    button.disabled = true;
    try {
      await resume(session);
      status.textContent = "Task selected. Send your follow-up in the conversation.";
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : "Couldn't continue this task.";
    } finally { button.disabled = false; }
  };
  root.append(button, status);
  return root;
}
