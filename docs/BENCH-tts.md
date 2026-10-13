# TTS: ElevenLabs vs on-device macOS speech

Run 2026-10-13T23:47:09.532Z · 5 runs per model and language · text streamed word by word, 30 ms apart (like the router's ack) · then flush.

- **eleven_v4_turbo**: Text-to-Dialogue WebSocket (one socket per segment, opened inside the measurement).
- **eleven_flash_v2_5**: TTS stream-input WebSocket.
- **openai_tts_1**: OpenAI `tts-1` over HTTP (`/v1/audio/speech`, `response_format: pcm`, voice `coral`), one request per sentence, the next requested while the current one streams.
- **kokoro**: Kokoro-82M ONNX on CPU (`tools/localtts`, voice af_heart; Romanian via espeak phonemes + the Italian voice if_sara), long sentences split at clauses.
- **piper**: Piper (`tools/localtts`, en_US-lessac-medium / ro_RO-mihai-medium, 22.05 kHz resampled to 24 kHz).
- **macos**: `tools/mactts` (AVSpeechSynthesizer, persistent helper, voices warmed): text goes a sentence at a time. Voices: best en-US voice installed, Ioana for Romanian.

### TTS alone (ms from the first text pushed)

| model · metric | p50 | p90 | n |
|---|---|---|---|
| eleven_v4_turbo · en · first audio | 485 | 524 | 5 |
| eleven_v4_turbo · en · done | 1823 | 1855 | 5 |
| eleven_v4_turbo · ro · first audio | 485 | 537 | 5 |
| eleven_v4_turbo · ro · done | 764 | 838 | 5 |
| eleven_flash_v2_5 · en · first audio | 631 | 686 | 5 |
| eleven_flash_v2_5 · en · done | 785 | 806 | 5 |
| eleven_flash_v2_5 · ro · first audio | 600 | 614 | 5 |
| eleven_flash_v2_5 · ro · done | 644 | 696 | 5 |
| openai_tts_1 · en · first audio | 1573 | 2497 | 5 |
| openai_tts_1 · en · done | 1876 | 3007 | 5 |
| openai_tts_1 · ro · first audio | 1338 | 1547 | 5 |
| openai_tts_1 · ro · done | 1777 | 2184 | 5 |
| macos · en · first audio | 299 | 306 | 5 |
| macos · en · done | 395 | 429 | 5 |
| macos · ro · first audio | 211 | 217 | 5 |
| macos · ro · done | 293 | 305 | 5 |
| kokoro · en · first audio | 688 | 744 | 5 |
| kokoro · en · done | 967 | 1016 | 5 |
| kokoro · ro · first audio | 601 | 619 | 5 |
| kokoro · ro · done | 844 | 869 | 5 |
| piper · en · first audio | 265 | 283 | 5 |
| piper · en · done | 298 | 310 | 5 |
| piper · ro · first audio | 198 | 224 | 5 |
| piper · ro · done | 235 | 241 | 5 |

Errors: 0.

### B turns up to the ack (real audio, claude -p agents, forced router, no fillers; ms from key release; the turn is cancelled after the ack, since the answer's timing is Opus's)

| model · metric | p50 | p90 | n |
|---|---|---|---|
| eleven_v4_turbo · TTFA (ack audio arrives) | 1416 | 1536 | 3 |
| eleven_v4_turbo · router first token → ack audio | 277 | 302 | 3 |
| macos · TTFA (ack audio arrives) | 1957 | 2251 | 3 |
| macos · router first token → ack audio | 264 | 305 | 3 |
| kokoro · TTFA (ack audio arrives) | 2312 | 13148 | 3 |
| kokoro · router first token → ack audio | 766 | 3761 | 3 |
| piper · TTFA (ack audio arrives) | 1642 | 1837 | 3 |
| piper · router first token → ack audio | 266 | 330 | 3 |

Errors: 0. TTFA here = when the first ack audio reaches the client (no playback buffering).

Raw runs: `docs/report-data/bench-tts.json`.

## Findings

*(Hand-written; kept when the tables are regenerated. 5 runs per cell for TTS alone, 3 turns per model — treat differences under ~150 ms as noise.)*

**Fastest to first audio: Piper (0.27 s en / 0.20 s ro) and macOS (0.30 / 0.21 s)**, then ElevenLabs v4 Turbo (0.49 s), Flash v2.5 (0.60–0.63 s), Kokoro (0.60–0.69 s) and OpenAI tts-1 (1.3–1.6 s). For the local engines most of that is waiting for the first full sentence while words stream in (7 words × 30 ms); Piper synthesizes a sentence in ~25–130 ms once loaded.

**In a real turn**, "router first token → ack audio" is ~0.27 s for v4 Turbo, macOS and Piper alike (ElevenLabs gets streamed text into a pre-opened socket; the local engines are already loaded). **Kokoro adds ~0.5 s (0.77 s)**: it runs on the CPU and returns audio only for a whole piece (long sentences are split at clauses to keep that short); one of its 3 turns had an unexplained 13 s outlier. CoreML acceleration doesn't help Kokoro here (only part of the graph runs on it; 1.47–1.78 s vs 1.36–1.48 s on CPU for a long sentence). OpenAI tts-1 has no streaming text input: a sentence wait + ~1 s request.

**Cost per 1K characters:** ElevenLabs $0.04 · OpenAI tts-1 $0.015 · macOS / Kokoro / Piper $0 (shown as saved vs ElevenLabs).

**Quality (by ear, not measured):** ElevenLabs most natural; **Kokoro is the most natural of the local options** in English (af_heart); Piper is clear but flatter; tts-1 decent; the compact macOS voices the most robotic unless a Premium/Enhanced voice is installed (System Settings → Accessibility → **Read & Speak** → System voice → Manage Voices…; restart `npm run dev`). **Romanian:** Piper has a native Romanian voice (ro_RO-mihai); Kokoro has none — Romanian is phonemized by espeak-ng and read with the Italian voice (accented); tts-1 voices are "optimized for English"; macOS uses Ioana.

**Startup:** `npm run dev` loads all local engines (Piper ~1.7 s, Kokoro ~2.6 s, macOS ~0.6 s incl. warm-up) — after `npm run setup:local-tts` once (~470 MB of models).

**Run notes:** turns are measured up to the ack and then cancelled (the answer's timing is Opus's, and Opus via `claude -p` was mid-refactor in the working tree).
