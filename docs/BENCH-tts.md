# TTS: ElevenLabs vs on-device macOS speech

Run 2026-10-13T23:25:32.697Z · 5 runs per model and language · text streamed word by word, 30 ms apart (like the router's ack) · then flush.

- **eleven_v4_turbo**: Text-to-Dialogue WebSocket (one socket per segment, opened inside the measurement).
- **eleven_flash_v2_5**: TTS stream-input WebSocket.
- **openai_tts_1**: OpenAI `tts-1` over HTTP (`/v1/audio/speech`, `response_format: pcm`, voice `coral`), one request per sentence, the next requested while the current one streams.
- **macos**: `tools/mactts` (AVSpeechSynthesizer, persistent helper, voices warmed): text goes a sentence at a time. Voices: best en-US voice installed, Ioana for Romanian.

### TTS alone (ms from the first text pushed)

| model · metric | p50 | p90 | n |
|---|---|---|---|
| eleven_v4_turbo · en · first audio | 484 | 525 | 5 |
| eleven_v4_turbo · en · done | 1832 | 1876 | 5 |
| eleven_v4_turbo · ro · first audio | 479 | 516 | 5 |
| eleven_v4_turbo · ro · done | 797 | 815 | 5 |
| eleven_flash_v2_5 · en · first audio | 589 | 650 | 5 |
| eleven_flash_v2_5 · en · done | 738 | 774 | 5 |
| eleven_flash_v2_5 · ro · first audio | 617 | 785 | 5 |
| eleven_flash_v2_5 · ro · done | 671 | 842 | 5 |
| openai_tts_1 · en · first audio | 1328 | 1517 | 5 |
| openai_tts_1 · en · done | 1697 | 2292 | 5 |
| openai_tts_1 · ro · first audio | 1089 | 1222 | 5 |
| openai_tts_1 · ro · done | 1732 | 2416 | 5 |
| macos · en · first audio | 299 | 376 | 5 |
| macos · en · done | 415 | 492 | 5 |
| macos · ro · first audio | 219 | 220 | 5 |
| macos · ro · done | 306 | 319 | 5 |

Errors: 0.

### B turns up to the ack (real audio, claude -p agents, forced router, no fillers; ms from key release; the turn is cancelled after the ack, since the answer's timing is Opus's)

| model · metric | p50 | p90 | n |
|---|---|---|---|
| eleven_v4_turbo · TTFA (ack audio arrives) | 2136 | 2551 | 4 |
| eleven_v4_turbo · router first token → ack audio | 248 | 304 | 4 |
| openai_tts_1 · TTFA (ack audio arrives) | 2859 | 3312 | 4 |
| openai_tts_1 · router first token → ack audio | 1441 | 1576 | 4 |
| macos · TTFA (ack audio arrives) | 1777 | 3024 | 4 |
| macos · router first token → ack audio | 270 | 316 | 4 |

Errors: 0. TTFA here = when the first ack audio reaches the client (no playback buffering).

Raw runs: `docs/report-data/bench-tts.json`.

## Findings

*(Hand-written; kept when the tables are regenerated. 5 runs per cell for TTS alone, 4 turns per model — treat differences under ~150 ms as noise.)*

**macOS on-device is the fastest to first audio** (0.30 s en / 0.22 s ro), then ElevenLabs v4 Turbo (0.48 s), Flash v2.5 (0.59–0.62 s), and **OpenAI tts-1 last (1.09–1.33 s)**. Most of the macOS time is waiting for the first full sentence while words stream in; synthesis itself is ~60–90 ms once the helper is warm.

**Why tts-1 is slow here:** `/v1/audio/speech` takes the whole input up front (no streaming text in), so the adapter waits for a complete sentence and then pays one HTTP request (~1 s to first PCM byte, which streams after that). ElevenLabs' WebSocket takes text as it streams and the pipeline pre-opens it, so in a real turn "router first token → ack audio" is **0.25 s (v4 Turbo) / 0.27 s (macOS) vs 1.44 s (tts-1)**, and the ack arrives ~0.7 s later with tts-1. The answer's timing is Opus's either way.

**Cost per 1K characters:** ElevenLabs $0.04 · OpenAI tts-1 $0.015 · macOS $0 (shown as saved vs ElevenLabs).

**Quality:** ElevenLabs sounds the most natural; tts-1 is decent (voice `coral`; others: alloy, ash, echo, fable, onyx, nova, sage, shimmer — set `OPENAI_TTS_VOICE`), with an accent in Romanian ("voices are optimized for English"); the compact macOS voices sound the most robotic unless a Premium/Enhanced voice is installed (System Settings → Accessibility → **Read & Speak** → System voice → Manage Voices… — "Spoken Content" before macOS 26; restart `npm run dev` afterwards). OpenAI's usage policy asks that end users be told the voice is AI-generated.

**Run notes:** full turns were measured up to the ack and then cancelled: in this run Opus (via `claude -p`, mid-refactor in the working tree) timed out or failed in 7 of 9 complete turns, which has nothing to do with speech.
