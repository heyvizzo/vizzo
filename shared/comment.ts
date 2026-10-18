// Comments (the pointer button in the browser toolbar): feedback typed or dictated into a bubble on a clicked
// element, sent as a turn that carries its text instead of audio (turn.start `text`). The client and the server lay
// the words out on the same synthetic timeline, so the pipeline's pointing and cursor rests see the clicked element
// for the whole "utterance" (the client sends samples on it across the span).
import type { Word } from "./protocol.ts";

/** Synthetic duration of one typed word. */
export const TYPED_WORD_MS = 300;

/** The text's words, one every TYPED_WORD_MS from 0 (seconds from the turn's audio start, as Scribe's words). */
export function typedWords(text: string): Word[] {
  return text.trim().split(/\s+/).filter(Boolean).map((w, i) => ({
    text: w,
    start: (i * TYPED_WORD_MS) / 1000,
    end: ((i + 1) * TYPED_WORD_MS - 50) / 1000,
  }));
}

/** How long the typed "utterance" lasts (ms): the span its cursor samples cover. */
export function typedSpanMs(text: string): number {
  return Math.max(1, typedWords(text).length) * TYPED_WORD_MS;
}
