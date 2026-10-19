/** True when the transcript has at least one word with a letter or number. Punctuation, noise tokens and a
 * recognizer's no-speech note ("(nothing heard)", "[BLANK_AUDIO]") do not count. */
export function hasSpokenWords(text: string, words: readonly { text: string }[] = []): boolean {
  if (isNoSpeechNote(text) || (words.length > 0 && isNoSpeechNote(words.map((w) => w.text).join(" ")))) return false;
  const parts = words.length > 0 ? words.map((w) => w.text) : text.trim() ? text.split(/\s+/) : [];
  return parts.some((part) => /[\p{L}\p{N}]/u.test(part));
}

// What some speech recognizers write instead of a transcript when nothing was said. Notes about speech that
// was there but unclear ("(unintelligible)", "[inaudible]") are not on these lists: the router asks about them.
const SILENCE = new RegExp("^(?:" + [
  "nothing(?: (?:was|is))?(?: (?:heard|said|spoken|detected|transcribed|recognized|recognised))?",
  "no (?:speech|audio|voice|voices|words|sound|sounds|dialogue|dialog|transcript|transcription|input)(?: (?:was|is))?(?: (?:heard|detected|present|found|recognized|recognised|in (?:the )?(?:audio|clip|recording)))?",
  "(?:the )?(?:audio|clip|recording) (?:is |was )?(?:silent|empty|blank)",
  "(?:blank|empty|silent) (?:audio|clip|recording)",
  "silence|silent|blank|empty|non ?speech|no one (?:is )?speaking|nobody (?:is )?speaking",
  "liniște|liniste|nimic|nu se aude nimic",
].join("|") + ")$", "u");
// Sounds that aren't speech: only in brackets ("[music]", "(coughs)"), since a bare word may be what was said.
const SOUND = /^(?:(?:soft |quiet |light |gentle |upbeat |background |ambient )*(?:music|noise|static|hum|humming|breathing|breath|breaths|sigh|sighs|sighing|cough|coughs|coughing|sniff|sniffs|sniffling|laugh|laughs|laughter|laughing|applause|clapping|typing|keyboard(?: clicking| typing)?|clicking|click|clicks|mouse clicks?|wind|beep|beeps|ticking|footsteps|rustling|sound|sounds|silence|pause|inhales|exhales|throat clearing|clears throat))(?: (?:playing|in (?:the )?background))?$/u;

const norm = (s: string): string => s.toLowerCase().replace(/[_-]+/g, " ").replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();

/**
 * True when the transcript is only a recognizer's note that nothing was said: "(nothing heard)",
 * "[BLANK_AUDIO]", "No speech detected.", "[music] [coughs]". Bracketed sounds count; bare ones don't.
 */
export function isNoSpeechNote(text: string): boolean {
  const notes: string[] = [];
  const rest = text.replace(/\[([^\]]*)\]|\(([^)]*)\)|<([^>]*)>|\*([^*]*)\*/g, (_, a, b, c, d) => {
    notes.push(norm(a ?? b ?? c ?? d ?? ""));
    return " ";
  });
  const bare = norm(rest);
  // Bare, only a phrase counts: "nothing" or "empty" alone may be the user's answer.
  if (!notes.length) return bare.includes(" ") && SILENCE.test(bare);
  return bare === "" && notes.every((n) => n === "" || SILENCE.test(n) || SOUND.test(n));
}
