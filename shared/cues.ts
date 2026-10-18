// Fish Audio Drama 3 acting cues (server/adapters/voiceCues.ts) are for the voice only: shown text drops them.

/** Removes bracketed directions ("[warm, pleased]") and voice tags ("<slow>…</slow>", keeping the words inside). */
export function stripVoiceCues(text: string): string {
  return text
    .replace(/\[[^\]\n]*\]?/g, "") // an unclosed "[" while streaming is hidden until it closes
    .replace(/<\/?(?:slow|fast|whisper|emphasis)>/gi, "")
    .replace(/<\/?[a-z]*$/i, "") // a tag still arriving at the end
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+|[ \t]+$/gm, "");
}
