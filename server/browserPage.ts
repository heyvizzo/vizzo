// The URL of the browser pane (left of the chat in the Electron app). The app's main process sends it whenever the
// page changes; every turn's context includes it, so the model knows which page the user is looking at.
import { normalizePageUrl } from "../shared/threads.ts";

let url: string | null = null;
const listeners = new Set<(url: string | null) => void>();

export function setBrowserUrl(next: string | null): void {
  const prev = url;
  url = next || null;
  if (url !== prev) for (const fn of [...listeners]) fn(url);
}

export function browserUrl(): string | null {
  return url;
}

/** Called whenever the browser pane's URL changes. Returns the unsubscribe. */
export function onBrowserUrl(fn: (url: string | null) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * The user is looking at this page (normalizePageUrl: a #fragment doesn't count as another page). True when either
 * side is unknown (no browser pane, or no page recorded): lines are spoken as they always were.
 */
export function onPage(page: string | null | undefined): boolean {
  if (!page || !url) return true;
  return normalizePageUrl(url) === normalizePageUrl(page);
}
