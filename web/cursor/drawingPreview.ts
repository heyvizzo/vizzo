import { isDrawingAnnotation, type DrawingAnnotation } from "../../shared/annotations.ts";

/** True while a captured drawing is open in this document (including closed shadow roots). */
export const DRAWING_PREVIEW_EVENT = "vizzo:drawing-preview";
const openPreviews = new WeakSet<Document>();
export const drawingPreviewOpen = (doc: Document = document): boolean => openPreviews.has(doc);

/** A safe, self-contained thumbnail that also works inside the page overlay's shadow root. */
export function drawingPreview(annotation: DrawingAnnotation, doc: Document = document): HTMLElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "drawing-preview";
  button.setAttribute("aria-label", "Open drawing on captured page");
  button.style.cssText = "display:block;box-sizing:border-box;width:100%;min-width:0;max-width:100%;margin:8px 0;padding:6px;border:1px solid var(--ui-line,var(--line,#d4d4d8));border-radius:8px;background:var(--ui-field,var(--field,#ffffff));color:var(--ui-text,var(--text,#18181b));cursor:zoom-in;text-align:left;font:inherit;pointer-events:auto";
  if (!isDrawingAnnotation(annotation)) {
    button.disabled = true;
    button.textContent = "Drawing unavailable";
    return button;
  }
  const img = doc.createElement("img");
  img.src = annotation.image.dataUrl;
  img.alt = "Drawing on the original captured page";
  img.width = annotation.image.width;
  img.height = annotation.image.height;
  img.style.cssText = "display:block;width:100%;height:auto;max-width:100%;object-fit:contain;border-radius:4px";
  const caption = doc.createElement("span");
  caption.textContent = `Drawing · ${annotation.strokes.length} mark${annotation.strokes.length === 1 ? "" : "s"} · Open original`;
  caption.style.cssText = "display:block;margin-top:5px;font-size:11px;line-height:1.45;color:var(--ui-muted,var(--muted,#71717a))";
  button.append(img, caption);
  button.addEventListener("click", () => {
    if (openPreviews.has(doc)) return;
    const dialog = doc.createElement("dialog");
    dialog.setAttribute("aria-label", "Drawing on original captured page");
    dialog.className = "drawing-lightbox";
    dialog.style.cssText = "position:fixed;inset:0;max-width:96vw;max-height:94vh;padding:12px;border:1px solid #777;border-radius:12px;background:#17181c;color:white;box-sizing:border-box;pointer-events:auto;box-shadow:0 10px 80px #0009";
    const style = doc.createElement("style");
    style.textContent = ".drawing-lightbox::backdrop { background: #000b; }";
    const close = doc.createElement("button");
    close.type = "button";
    close.textContent = "Close drawing";
    close.style.cssText = "display:block;margin:0 0 10px auto;padding:8px 12px;background:#333;color:white;border:1px solid #888;border-radius:6px;cursor:pointer;font:14px system-ui";
    const full = img.cloneNode() as HTMLImageElement;
    full.style.cssText = "display:block;max-width:calc(96vw - 26px);max-height:calc(94vh - 80px);width:auto;height:auto;object-fit:contain";
    let cleaned = false;
    const notify = (open: boolean) => doc.dispatchEvent(new CustomEvent(DRAWING_PREVIEW_EVENT, { detail: { open }, bubbles: true, composed: true }));
    const removal = new MutationObserver(() => { if (!dialog.isConnected) cleanup(); });
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      removal.disconnect();
      doc.defaultView?.removeEventListener("pagehide", cleanup);
      openPreviews.delete(doc);
      dialog.remove();
      notify(false);
      if (button.isConnected) button.focus();
    };
    close.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", cleanup, { once: true });
    dialog.addEventListener("click", (e) => {
      if (e.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
    });
    dialog.append(style, close, full);
    const root = button.getRootNode();
    (root instanceof ShadowRoot ? root : doc.body).append(dialog);
    // The modal belongs to the stable overlay root, so replacing a thread's rows leaves it open.
    // Observe that root and its host's document to release state if either is removed externally.
    removal.observe(root, { childList: true, subtree: true });
    if (root !== doc) removal.observe(doc, { childList: true, subtree: true });
    doc.defaultView?.addEventListener("pagehide", cleanup, { once: true });
    openPreviews.add(doc);
    try {
      dialog.showModal();
      notify(true);
      close.focus();
    } catch (error) {
      cleanup();
      throw error;
    }
  });
  return button;
}
