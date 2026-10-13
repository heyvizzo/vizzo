// Push-to-talk: hold Space (outside inputs) or hold the given button. Implemented by T2.

export interface PttOpts { button?: HTMLElement; onPress: () => void; onRelease: () => void }

/** Returns an unbind function. */
export function bindPushToTalk(_opts: PttOpts): () => void {
  throw new Error("bindPushToTalk: not implemented (T2)");
}
