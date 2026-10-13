// Dev-only canned session for the cursor lab (`/cursor.html?demo=1`, or `?demo=title`): a fake turn
// "Make this title match that column" that points at a card title and a table heading, clicks the
// heading, and has a card sentence highlighted, so the inspector, overlay, picks, LLM context and
// timeline can be seen (and screenshotted) without a mic or server.
import type { CursorSample, PageClick, Word } from "../../shared/protocol.ts";
import { describeElement, type ElLike } from "./dom.ts";
import { labelsFor, type LabSession } from "./session.ts";

const center = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
};

export function cannedSession(root: HTMLElement, scroller: HTMLElement): LabSession | null {
  const title = root.querySelector(".card h3");
  const th = root.querySelectorAll(".pricing-table th")[3];
  const para = root.querySelector(".card p");
  if (!title || !th || !para) return null;
  // Scroll so the table heading sits near the bottom of the demo pane and the card title above it
  // (elementFromPoint only sees what's in view).
  const sr = scroller.getBoundingClientRect();
  const visibleBottom = Math.min(sr.bottom, window.innerHeight);
  scroller.scrollTop += th.getBoundingClientRect().bottom - visibleBottom + 24;

  const describeAt = (x: number, y: number) => describeElement(document.elementFromPoint(x, y) as ElLike | null, root as unknown as ElLike);
  const a = center(title);
  const b = center(th);
  const samples: CursorSample[] = [];
  for (let t = -400; t <= 1900; t += 16) {
    const k = t < 650 ? 0 : t > 1000 ? 1 : (t - 650) / 350;
    const jitter = Math.sin(t / 37) * 1.5; // a resting hand isn't perfectly still
    const x = Math.round(a.x + (b.x - a.x) * k + jitter);
    const y = Math.round(a.y + (b.y - a.y) * k);
    samples.push({ t, x, y, scrollX: scroller.scrollLeft, scrollY: scroller.scrollTop, ...describeAt(x, y) });
  }
  const words: Word[] = [
    { text: "Make", start: 0.0, end: 0.2 }, { text: "this", start: 0.25, end: 0.45 }, { text: "title", start: 0.5, end: 0.75 },
    { text: "match", start: 0.8, end: 1.0 }, { text: "that", start: 1.1, end: 1.3 }, { text: "column.", start: 1.35, end: 1.7 },
  ];
  const clicks: PageClick[] = [{ t: 1180, ...b, ...describeAt(b.x, b.y) }];

  // Highlight the first sentence of the card text, for real, so it shows on the page.
  const text = para.firstChild;
  let selection: LabSession["selection"] = null;
  if (text?.nodeType === Node.TEXT_NODE) {
    const sentence = "Charts refresh as rows land.";
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, Math.min(sentence.length, text.textContent!.length));
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    selection = { t: -600, text: sentence, ...describeElement(para as unknown as ElLike, root as unknown as ElLike) };
  }

  const labels = labelsFor(words);
  if (labels[0]) labels[0].target = describeElement(title as unknown as ElLike, root as unknown as ElLike);
  if (labels[1]) labels[1].target = describeElement(th as unknown as ElLike, root as unknown as ElLike);
  return {
    id: "DEMO", createdAt: new Date().toISOString(), transcript: words.map((w) => w.text).join(" "), words, samples, labels,
    viewport: { width: scroller.clientWidth, height: scroller.clientHeight }, clicks, selection,
  };
}

/** Moves the (synthetic) pointer onto an element so the live inspector and hover outline show it. */
export function hoverElement(el: Element | null): void {
  if (!el) return;
  const { x, y } = center(el);
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));
}
