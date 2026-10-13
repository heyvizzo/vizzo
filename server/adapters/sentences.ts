// Sentence splitting for TTS that synthesizes a sentence at a time (on-device macOS, OpenAI tts-1).

/** Split off complete sentences ("…. " / "…? " / "…! "); returns [sentences, rest]. */
export function takeSentences(text: string): [string[], string] {
  const out: string[] = [];
  const re = /[^.!?…]*[.!?…]+["'”’)]*(\s+|$)/gy;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && m[0].length) {
    if (!m[1] && m.index + m[0].length === text.length) break; // sentence end at the very end: wait for more (or flush)
    out.push(m[0].trim());
    last = re.lastIndex;
  }
  return [out.filter(Boolean), text.slice(last)];
}

/**
 * Split a long sentence at clause boundaries (", " "; " ": " " — "), keeping each piece at least `min`
 * characters, for engines that synthesize a whole piece before returning audio (Kokoro). Short
 * sentences come back whole.
 */
export function splitClauses(sentence: string, max = 70, min = 25): string[] {
  if (sentence.length <= max) return [sentence];
  const parts = sentence.split(/(?<=[,;:])\s+|\s+(?=—)/);
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    cur = cur ? `${cur} ${p}` : p;
    if (cur.length >= min) { out.push(cur); cur = ""; }
  }
  if (cur) { if (out.length && cur.length < min) out[out.length - 1] += ` ${cur}`; else out.push(cur); }
  return out;
}
