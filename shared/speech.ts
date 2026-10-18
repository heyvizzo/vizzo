/** True when the transcript has at least one word with a letter or number. Punctuation and noise tokens do not count. */
export function hasSpokenWords(text: string, words: readonly { text: string }[] = []): boolean {
  const parts = words.length > 0 ? words.map((w) => w.text) : text.trim() ? text.split(/\s+/) : [];
  return parts.some((part) => /[\p{L}\p{N}]/u.test(part));
}
