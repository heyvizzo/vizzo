// Acting cues for Fish Audio Drama 3, English only. Added to the per-turn the solver and router messages when the reply
// is spoken by Drama 3 (pipeline and background jobs), so other engines never receive brackets or tags.
// Checked on the API: bracketed direction (not spoken), <slow>, <fast>, <whisper>. Documented by Fish: <emphasis>, [small laugh].

/** The solver: the SPOKEN line gets the cues; the detailed answer never does. */
export const FISH_SOLVER_CUES = `## Voice: Fish Audio Drama 3
The SPOKEN line is read aloud by Drama 3, which can act. Add acting cues to the SPOKEN line only, never to the detailed answer, and never in code or file names.
- A bracketed direction before a sentence sets how it is delivered, e.g. [clear, measured]. Brackets are not spoken.
- <slow>…</slow> stretches the words inside it, for thinking aloud: <slow>Hmmm, let me think about that.</slow>
- <fast>…</fast> speeds them up, for boilerplate and lists.
- <emphasis>…</emphasis> stresses one word: "Click <emphasis>this</emphasis> button."
- <whisper>…</whisper> for an aside.
- [small laugh] or [sigh] inline, at most once per reply.
Rules: every tag and bracket stays inside one sentence. At most two cues per sentence. The SPOKEN line stays under 25 words, cues included. Examples by answer type:
- Pointing: [pointing it out, friendly] Click <emphasis>this</emphasis> button, then open the panel.
- Thinking: [thinking hard, working it out] <slow>Hmmm, the cache is probably the cause.</slow>
- Good news: [warm, pleased] Done, the button now sits on the right.
- Problem: [apologetic, calm] Sorry, I couldn't find that file.
- Technical: [clear, measured] The grid uses three equal columns.`;

/**
 * Progress lines while the solver works. The app speaks each line as its own TTS take, so each line should be one
 * long sentence: a full stop inside it makes Drama 3 start and stop again. Stretched words sound like hard thinking.
 */
export const FISH_FILLER_CUES = `## Voice: Fish Audio Drama 3
Each line is read aloud by Drama 3 as its own take. This section overrides the 4 to 10 word limit above.
- Write each line as ONE long sentence of 12 to 18 words, joined with commas and dashes. No full stop inside a line.
- Stretch one or two key words with <slow>…</slow>, so the voice sounds like it is working something out: <slow>check</slow>, <slow>hmmm</slow>, <slow>looking</slow>.
- Start each line with a bracketed direction (not spoken), and vary it across the lines, e.g. [thinking hard, working it out], [focused, searching], [puzzled, steady].
- No tags across lines, and no more than two cues per line.
Example: [thinking hard, working it out] Let me <slow>check</slow> that image's format, I'm opening the element you pointed at, and now I'm <slow>looking</slow> at where its source address points.
- These rules are for the lines. The cut_in stays short (3 to 8 words) and may start with one bracketed direction, e.g. [quick, pleasantly surprised] Oh, wait, here it is.`;

/** Router: the `say` line (the acknowledgment) can carry a cue too. */
export const FISH_ACK_CUES = `## Voice: Fish Audio Drama 3
The \`say\` line is read aloud by Drama 3, which can act. You may add one cue, at most: a bracketed direction (not spoken), <slow>…</slow> or <fast>…</fast> around a word or two. Keep the line to 3 to 10 words. Examples: [quick, casual] Let me check that. / [thinking hard, working it out] <slow>Hmm, let me look.</slow>`;

/** Cues apply when Drama 3 speaks and the user spoke English (no language = English). */
export function useVoiceCues(ttsModel: string, language: string | undefined): boolean {
  return ttsModel === "fish_drama_3" && (!language || language.startsWith("en"));
}
