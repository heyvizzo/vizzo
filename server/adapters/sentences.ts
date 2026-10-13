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
