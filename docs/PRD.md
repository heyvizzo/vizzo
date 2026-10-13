# PRD: Realtime Voice Latency Lab

Status: draft v1 · 2026-10-13

## 1. Background

We want to build a "talk to your app" tool. You open a web project (later, any app on the OS), hold a key, point at things with the cursor, and ask out loud: "why is *this* built with a grid?" or "make *that* button smaller". A fast voice layer replies right away. Opus 5.5 handles the hard questions and the code changes.

Before building that product, this lab answers two questions with measurements, not guesses:

1. **Latency.** Which voice architecture gives the best time-to-first-audio and time-to-answer when hard questions are delegated to Opus?
2. **Pointing.** How reliably can we work out which element the user meant, by lining up word-level speech timestamps with a recorded cursor trail?

## 2. Goals

- G1. Compare three voice architectures end to end on **identical input**, using recorded utterances replayed N times per approach.
- G2. Break each turn down by stage: STT, LLM first token, tool call, Opus, TTS, playback.
- G3. Report p50 and p90 per approach and per stage, and export the raw runs.
- G4. A cursor lab that records the cursor, transcribes with word timestamps, resolves pointing words ("this", "that", "here"…) to DOM elements with several algorithms, and visualizes the result.
- G5. Feed the resolved pointing context into the voice approaches, so the latency numbers include it.

## 3. Non-goals (for this lab)

- OS-wide capture (Swift menu-bar app, Accessibility API). That's phase 2 and is designed separately.
- A browser extension. The lab is a standalone web app with its own demo page.
- Real code edits by Opus. Opus answers questions about a fixture codebase; it doesn't write files.
- Production auth, multi-user support, deployment. Local only.
- Barge-in (interrupting the agent mid-reply). It may be measured later.

## 4. The three approaches

Every approach uses **push-to-talk** (hold Space or the on-screen button) and the same `ask_opus` tool for hard tasks.

| ID | Name | Voice in → thinking → voice out | Hard tasks |
|---|---|---|---|
| **A** | `realtime` | OpenAI Realtime (`gpt-realtime-2.1`, switchable to `-mini`) does STT + reasoning + TTS in one model | Realtime calls the `ask_opus` function → Opus 5.5 → result returned → Realtime speaks a summary |
| **B** | `pipeline` | ElevenLabs Scribe v2 Realtime → Claude Haiku 5.5 → ElevenLabs Eleven v4 Turbo | Haiku calls `ask_opus` → Opus 5.5 → the spoken summary is streamed to TTS |
| **C** | `hybrid` | OpenAI Realtime for voice, **plus** Scribe in parallel for word timestamps. On key release, wait for the Scribe commit (bounded timeout), resolve the pointing words, inject them as a context item, then `response.create` | Same as A |

Approach C exists because speech-to-speech models don't return word timestamps, and we need those for pointing. It measures what pointing costs on top of a realtime voice model.

### Hard-task protocol (all approaches)

1. The voice layer decides the request is hard (or the router always delegates, depending on config) and calls `ask_opus({question, pointing_context})`.
2. The voice layer **immediately** speaks a short acknowledgment ("checking the styles…").
3. Opus is prompted to put a 1–3 sentence `SPOKEN:` summary **first**, then the detailed answer. As soon as the spoken line is complete, it streams to TTS (B) or back to the realtime model as the function output (A/C).
4. The full Opus answer is shown as text in the UI.

## 5. Users and scenarios

The only user is the developer (you), running locally on macOS in Chrome.

Benchmark utterances live in `fixtures/utterances/`. Each is a recorded WAV file plus a matching cursor-trail JSON:

| ID | Utterance | Kind |
|---|---|---|
| U1 | "What color is this button?" | easy, 1 pointing word |
| U2 | "Make this card a bit wider." | easy, change request |
| U3 | "Why is this section built with a grid instead of flexbox?" | hard → Opus |
| U4 | "Move this over there." | 2 pointing words |
| U5 | "Why does the header stick when I scroll down here?" | hard → Opus, 1 pointing word |

## 6. Functional requirements

### Latency lab (`/` page)
- FR1. Choose the approach (A/B/C), model variants (`gpt-realtime-2.1` | `-mini`, Opus fast mode on/off) and input (live mic, or a recorded fixture).
- FR2. Live mode: hold to talk, release to send. Audio playback starts as soon as the first chunk arrives.
- FR3. Replay mode: stream a fixture WAV at real-time speed, with its cursor trail replayed, then "release" automatically. Run N times per approach (default 10), sequentially, with a cooldown.
- FR4. Per-turn waterfall showing every timing mark (see ARCHITECTURE §5).
- FR5. Results table: p50/p90/mean per approach × metric. Export JSON and CSV. Runs are also appended to `results/*.jsonl` on the server.
- FR6. Show the transcript, the resolved pointing targets, the voice-layer text, and the Opus answer for each turn.

### Cursor lab (`/cursor` page)
- FR7. A demo UI with distinct, labeled targets: sticky header, nav links, hero with CTA button, card grid, form, table. Every element carries `data-source="file:line"`.
- FR8. Sample the pointer about 60 Hz in rAF, recording `{t, x, y, scrollX, scrollY, elementPath, dataSource}`. Look up the element **at sample time**.
- FR9. Hold to talk → Scribe with `include_timestamps=true` and `commit_strategy=manual` → word list.
- FR10. Resolve pointing words with several algorithms side by side (see ARCHITECTURE §6) and highlight each one's pick with its own color.
- FR11. Timeline view: cursor speed over time, word spans overlaid, pointing-word windows shaded, the chosen sample marked.
- FR12. Save a session (audio WAV + cursor trail + words + expected targets) as a fixture for the latency lab and for resolver regression tests.
- FR13. Label each pointing word with its correct element (click it), so resolver accuracy can be scored per algorithm.

## 7. Success metrics (what the lab must produce)

| Metric | Definition |
|---|---|
| **TTFA** | Time to first audio: key release → first audio sample **played** |
| **TTA** | Time to answer: key release → first sample of the *answer* audio played. For hard tasks this is after Opus; otherwise it equals TTFA |
| Stage breakdown | Release → STT final, → LLM first token, → tool call, → Opus first token, → Opus spoken line ready, → TTS first byte |
| Resolver accuracy | % of pointing words resolved to the labeled element, per algorithm, over all saved sessions |
| Cost per turn | Estimated from token, character and minute usage, using the prices in `API-NOTES.md` |

**Deliverable:** `docs/REPORT.md`, with p50/p90 tables per approach, resolver accuracy, cost per turn, and a recommendation.

## 8. Constraints

- API keys live **only** on the server (`.env`). The browser never sees a vendor key.
- Every vendor call goes through the local Node server over one browser↔server WebSocket, so timing is consistent across approaches. (WebRTC to OpenAI is a possible follow-up comparison; see ARCHITECTURE §8.)
- Model IDs are exact: `claude-haiku-5-5`, `claude-opus-5-5`, `gpt-realtime-2.1`, `gpt-realtime-2.1-mini`, `scribe_v2_realtime`, `eleven_v4_turbo`.

## 9. Open questions

- Should C wait for the Scribe commit, or start `response.create` immediately and inject the pointing context only if Scribe arrives first? Measure both (config flag `hybridWaitMs`, default 400).
- Is the Haiku router better with forced `tool_choice` (fastest, no thinking) or `auto` (can answer easy questions itself)? Measure both (config flag `routerMode`).
- Whether Opus fast mode ($8/$40 per MTok, up to 2.5× output speed) is worth it for TTA.
