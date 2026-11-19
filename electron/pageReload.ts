import type { WebContents } from "electron";
import { endsHold, hotkeys, type Hotkey } from "../shared/hotkeys.ts";
import type { CommentSnapshot } from "../web/cursor/commentOverlay.ts";
import type { PanelSnapshot } from "../web/cursor/threadPanel.ts";

export interface PageEditors {
  panel: PanelSnapshot | null;
  comment: CommentSnapshot | null;
  activeId?: string;
}

/** The private handoff between successive documents in this browser pane. */
export function installPageReload(contents: WebContents, ready: () => void, talk: (down: boolean) => void): void {
  let documentId: string | undefined;
  let saved: { url: string; editors: PageEditors } | undefined;
  // The document that saw keydown can disappear before keyup. The pane still sees the native release.
  let hold: { key: Hotkey; url: string } | null = null;
  function release(): void {
    if (!hold) return;
    hold = null;
    talk(false);
  }
  contents.ipc.on("ptt", (_event, down: boolean) => {
    if (!down) return release();
    if (hold) return;
    hold = { key: hotkeys().talk, url: contents.getURL() };
    talk(true);
  });
  contents.on("before-input-event", (_event, input) => {
    if (hold && input.type === "keyUp" && endsHold(input, hold.key)) release();
  });
  contents.on("blur", release);
  contents.on("render-process-gone", release);
  contents.ipc.on("page:suspend", (_event, id: string, url: string, editors: PageEditors) => {
    if (id === documentId) saved = { url, editors };
  });
  contents.ipc.on("page:restored", (_event, id: string) => {
    if (id === documentId) saved = undefined;
  });
  contents.on("did-navigate", (_event, url) => {
    if (hold && hold.url !== url) release();
    if (saved?.url !== url) saved = undefined;
  });
  contents.ipc.on("page:ready", (event, id: string) => {
    const frame = event.senderFrame;
    if (!frame || frame !== contents.mainFrame) return;
    documentId = id;
    frame.send("page:restore", saved?.url === frame.url ? saved.editors : null, !!hold);
    // A second reload can interrupt delivery or arrive before the thread list. Keep it until mounted.
    ready();
  });
}
