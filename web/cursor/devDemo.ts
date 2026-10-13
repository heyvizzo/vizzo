// Dev-only canned session for the cursor lab (`/cursor.html?demo=1`, or `?demo=title`): a fake turn
// "Make this title match that column" that points at a card title and a table heading, with every kind
// of page event: a single, a double, a triple and a 5× click, a sentence already highlighted when the
// recording started, and two highlights made during it (two table rows by drag, a phrase by
// double-click), so the inspector, overlay, picks, LLM context and timeline can be seen (and
// screenshotted) without a mic or server.
import type { CursorSample, PageClick, PageHighlight, Word } from "../../shared/protocol.ts";
import { clickKind } from "./pageContext.ts";
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
  const ref = (el: Element) => describeElement(el as unknown as ElLike, root as unknown as ElLike);
  /** A click event on `el` with presses at `times` (release 90 ms after the last). */
  const click = (el: Element, times: number[]): PageClick => {
    const p = center(el);
    return { ...ref(el), kind: clickKind(times.length), count: times.length, t: times[0]!, tEnd: times[times.length - 1]! + 90, times, ...p };
  };
  const title2 = root.querySelectorAll(".card h3")[1];
  const cell = root.querySelector(".pricing-table tbody tr:nth-of-type(2) td:nth-of-type(4)");
  const clicks: PageClick[] = [
    click(title, [180, 340, 495]), // triple: "this title"
    ...(title2 ? [click(title2, [-250])] : []), // a single click before speaking
    click(th, [1150, 1310]), // double: "that column"
    ...(cell ? [click(cell, [1420, 1540, 1660, 1790, 1905])] : []), // 5× on the Team price
  ];

  // Already highlighted when the recording started: the first sentence of the card text, selected for
  // real so it shows on the page (and a real recording started now would snapshot it).
  const text = para.firstChild;
  let preselected: LabSession["preselected"] = null;
  if (text?.nodeType === Node.TEXT_NODE) {
    const sentence = "Charts refresh as rows land.";
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, Math.min(sentence.length, text.textContent!.length));
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    preselected = { t: -500, text: sentence, ...ref(para) };
  }
  // Made during the recording: two table rows (drag) and a phrase in the Embeds card (double-click).
  const tbody = root.querySelector(".pricing-table tbody");
  const embeds = root.querySelector(".card--wide p");
  const highlights: PageHighlight[] = [
    ...(tbody ? [{ text: "Hobby\t3\t5\t$0\nTeam\tUnlimited\t50\t$49", tStart: 560, t: 980, via: "drag" as const, ...ref(tbody) }] : []),
    ...(embeds ? [{ text: "script", tStart: 1230, t: 1400, via: "double-click" as const, ...ref(embeds) }] : []),
  ];

  const labels = labelsFor(words);
  if (labels[0]) labels[0].target = describeElement(title as unknown as ElLike, root as unknown as ElLike);
  if (labels[1]) labels[1].target = describeElement(th as unknown as ElLike, root as unknown as ElLike);
  return {
    id: "DEMO", createdAt: new Date().toISOString(), transcript: words.map((w) => w.text).join(" "), words, samples, labels,
    viewport: { width: scroller.clientWidth, height: scroller.clientHeight }, clicks, preselected, highlights,
  };
}

/** Moves the (synthetic) pointer onto an element so the live inspector and hover outline show it. */
export function hoverElement(el: Element | null): void {
  if (!el) return;
  const { x, y } = center(el);
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));
}
