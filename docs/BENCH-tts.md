# TTS: ElevenLabs vs on-device macOS speech

Run 2026-10-13T22:31:21.508Z · 5 runs per model and language · text streamed word by word, 30 ms apart (like the router's ack) · then flush.

- **eleven_v4_turbo**: Text-to-Dialogue WebSocket (one socket per segment, opened inside the measurement).
- **eleven_flash_v2_5**: TTS stream-input WebSocket.
- **macos**: `tools/mactts` (AVSpeechSynthesizer, persistent helper, voices warmed): text goes a sentence at a time. Voices: best en-US voice installed, Ioana for Romanian.

### TTS alone (ms from the first text pushed)

| model · metric | p50 | p90 | n |
|---|---|---|---|
| eleven_v4_turbo · en · first audio | 533 | 572 | 5 |
| eleven_v4_turbo · en · done | 1914 | 1936 | 5 |
| eleven_v4_turbo · ro · first audio | 545 | 547 | 5 |
| eleven_v4_turbo · ro · done | 784 | 841 | 5 |
| eleven_flash_v2_5 · en · first audio | 626 | 690 | 5 |
| eleven_flash_v2_5 · en · done | 774 | 818 | 5 |
| eleven_flash_v2_5 · ro · first audio | 614 | 679 | 5 |
| eleven_flash_v2_5 · ro · done | 720 | 772 | 5 |
| macos · en · first audio | 287 | 291 | 5 |
| macos · en · done | 388 | 394 | 5 |
| macos · ro · first audio | 211 | 218 | 5 |
| macos · ro · done | 291 | 306 | 5 |

Errors: 0.

### Full B turns (real audio, claude -p agents, forced router, no fillers; ms from key release)

| model · metric | p50 | p90 | n |
|---|---|---|---|
| eleven_v4_turbo · TTFA (ack heard) | 1697 | 1897 | 3 |
| eleven_v4_turbo · router first token → ack audio | 302 | 333 | 3 |
| eleven_v4_turbo · TTA (answer heard) | 3838 | 5241 | 3 |
| macos · TTFA (ack heard) | 1477 | 1579 | 3 |
| macos · router first token → ack audio | 310 | 338 | 3 |
| macos · TTA (answer heard) | 4093 | 4198 | 3 |

Errors: 0. Played times are approximate (headless client reports the first byte as played).

Raw runs: `docs/report-data/bench-tts.json`.

## Findings

*(Hand-written; kept when the tables are regenerated. 5 runs per cell for TTS alone, 3 full turns per model — treat differences under ~150 ms as noise.)*

**On its own, macOS speech is about twice as fast to first audio:** 0.29 s (en) / 0.21 s (ro) vs 0.53 s for v4 Turbo and 0.62 s for Flash. Most of the macOS time is waiting for the first complete sentence while words stream in (7 words × 30 ms); synthesis itself is ~60–90 ms once the helper is warm, and a whole sentence takes ~0.1 s (much faster than real time).

**In a full turn it's a wash.** The pipeline already pre-opens the ElevenLabs socket and streams the router's text into it, so "router first token → ack audio" is ~0.30 s either way, and TTFA is 1.48 s (macOS) vs 1.70 s (v4 Turbo) — within noise at n = 3. Time to the answer is dominated by Opus.

**It costs nothing** (no per-character bill; shown as saved vs ElevenLabs' $0.04 / 1K characters) and works offline.

**The trade-off is voice quality.** Only the compact system voices are installed here (Samantha for English, Ioana for Romanian); they sound noticeably more robotic than ElevenLabs. Installing a Premium/Enhanced voice (System Settings → Accessibility → Spoken Content → System voice → Manage Voices, e.g. "Ava (Premium)" or "Zoe (Premium)") makes the helper pick it automatically — it chooses the highest-quality voice per language at start.
