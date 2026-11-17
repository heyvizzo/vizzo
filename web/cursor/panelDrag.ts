/** Drag a floating panel by its header. Capture on the panel: its header may be replaced by a live update. */
export function enablePanelDrag(root: HTMLElement, headerSelector: string, move: (left: number, top: number) => void): void {
  let drag: { id: number; x: number; y: number; left: number; top: number; moved: boolean } | null = null;

  root.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || drag || !(e.target instanceof Element)) return;
    const head = e.target.closest(headerSelector);
    if (!head || !root.contains(head) || e.target.closest("button, a, input, select, textarea, [contenteditable], [role=button]")) return;
    e.preventDefault(); // Keep the form's focus and avoid selecting the header's text.
    const rect = root.getBoundingClientRect();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: rect.left, top: rect.top, moved: false };
    root.setPointerCapture(e.pointerId);
  });

  root.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    e.preventDefault();
    e.stopPropagation();
    drag.moved = true;
    root.classList.add("dragging");
    move(drag.left + dx, drag.top + dy);
  });

  const end = (e: PointerEvent) => {
    if (!drag || drag.id !== e.pointerId) return;
    drag = null;
    root.classList.remove("dragging");
    if (root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
  };
  root.addEventListener("pointerup", end);
  root.addEventListener("pointercancel", end);
  root.addEventListener("lostpointercapture", end);
}
