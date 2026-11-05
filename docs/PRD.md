# PRD: talk to your app (voice + pointing)

Status: v2 · 2026-10-17 (v1, 2026-10-13, was a latency lab comparing three voice architectures plus a cursor lab; see §9)

## 1. Background

We want a "talk to your app" tool. You open a web project (later, any app on the OS), point at things with the cursor, and ask out loud: "why is *this* built with a grid?" or "make *that* button smaller". A fast voice layer replies right away. A stronger model, the solver, handles the hard questions and the code changes.

## 2. Goals

- G1. A desktop app (Electron) with the project's page in a browser pane and a voice chat sidebar next to it.
- G2. Work out which element the user meant by lining up word-level speech timestamps with the cursor trail, clicks and selected text, and give that to every model.
- G3. Fast first audio: a short spoken acknowledgment or answer right after the user stops talking, with the solver's answer following.
- G4. Keep each piece of feedback with its element (element threads), so follow-ups, corrections and results stay attached to it.
- G5. Measure every turn by stage and by cost, and keep the raw runs.

## 3. Non-goals

- OS-wide capture (Swift menu-bar app, Accessibility API). That's phase 2 and is designed separately.
- A browser extension.
- Production auth, multi-user support, deployment. Local only.

## 4. How it works

The voice layer is a **pipeline**: speech-to-text (ElevenLabs Scribe v2 Realtime by default; OpenRouter and on-device models are options) → pointing resolution → the **router** on the fast tier → text-to-speech (ElevenLabs Eleven v4 Turbo by default; OpenAI tts-1, Fish Audio Drama 3 and on-device voices are options). The **solver** on the smart tier takes questions and tasks the router hands over and works in the project folder with file tools. Each tier runs on a coding-agent harness (Claude Code, Codex, Grok, opencode, Pi, OhMyPi) with a model, and a reasoning level and speed where offered.

### Hard-task protocol

1. The router classifies the turn (question / task / clarify / answer) with a time estimate. In `auto` mode it answers easy ones itself; in `forced` mode it always delegates.
2. When it delegates, it **immediately** speaks a short acknowledgment ("checking the styles…").
3. The solver is prompted to put a 1–3 sentence `SPOKEN:` summary **first**, then the detailed answer. As soon as the spoken line is complete, it streams to TTS.
4. Short tasks get spoken progress lines while the solver works. Long ones (estimate above the long-task threshold) run in the background and are announced when done.
5. The full solver answer is shown as text in the sidebar.

## 5. Users

The only user is the developer (you), running locally on macOS.

## 6. Functional requirements

### Talking
- FR1. Hold the talk key (Control by default, set in Settings → Keyboard) or the talk button to talk, or turn on Always listen (level-based voice detection). Audio playback starts as soon as the first chunk arrives.
- FR2. Pressing while the assistant talks interrupts it; Esc stops it.
- FR3. English and Romanian, detected or pinned (Language setting).
- FR4. The conversation is remembered across turns until "New conversation".

### Pointing
- FR5. Sample the pointer in the page about 60 Hz, recording the element under it at sample time.
- FR6. Resolve pointing words ("this", "that", "ăsta"…) against the cursor trail (ARCHITECTURE §6), add cursor rests, clicks and selected text, and send them to the router and the solver.
- FR7. Show each turn's pointing picks as chips, and optionally outline them on the page.

### Threads and comments
- FR8. Feedback on an element opens a thread with its own persistent solver session and a marker on the page showing its state (running, pending, idle, failed). Follow-ups and corrections go to the same thread.
- FR9. A finished thread is spoken in full when it's the focused one, otherwise as a one-line reminder.
- FR10. Comment mode: click an element and type (or dictate) feedback in a bubble on it. With Instant off, turns queue until Send.
- FR15. Drawing mode: annotate a captured page with pen, arrows, boxes and ellipses, select and move marks, then type or dictate a request. Link spoken phrases from one recording or several voice notes to numbered marks, with editable timing suggestions and explicit selection links. Send the annotated screenshot, phrase links and captured element context as one turn, preserving it through queued feedback and thread messages. Reopen submitted drawings against their original image.

### Settings and visibility
- FR11. Choose the router mode, the harness / model / level / speed per tier, the TTS and STT models (and voice), and the long-task threshold. Settings persist.
- FR12. Show the transcript, voice text, solver answer, timing marks and itemized cost per turn, and the exact prompt and raw response of every model call.
- FR13. Show what a subscription (CLI login) or on-device engine saved compared with API prices.
- FR14. Append every turn to `results/chat-*.jsonl` on the server.

## 7. Success metrics

| Metric | Definition |
|---|---|
| **TTFA** | Time to first audio: key release (or end of speech) → first audio sample **played** |
| **TTA** | Time to answer: release → first sample of the *answer* audio played. For delegated turns this is after the solver; otherwise it equals TTFA |
| Stage breakdown | Release → STT final, → LLM first token, → tool call, → solver first token, → solver spoken line ready, → TTS first byte |
| Cost per turn | From token, character and second usage, using the prices in `API-NOTES.md` |

Benchmarks replay recorded WAVs headless (`npm run smoke:e2e`, `npm run bench:*`); results are in `docs/BENCH-*.md`.

## 8. Constraints

- API keys live **only** on the server (the app's settings; there is no `.env`). The page and sidebar never see a vendor key.
- Every vendor call goes through the local Node server over one sidebar↔server WebSocket, so timing is measured in one place.

## 9. History

- 2026-10-13: v1 was a latency lab: three voice architectures (A: OpenAI Realtime speech-to-speech; B: this pipeline; C: Realtime plus Scribe for pointing) replayed on recorded utterances, and a cursor lab that scored pointing algorithms against labeled sessions.
- The lab pages were replaced by the Electron app and its Chat sidebar.
- 2026-10-17: A and C were removed; only the pipeline is developed. Git history has them.

## 10. Open questions

- Is the router better in `forced` mode (always delegates) or `auto` (can answer easy questions itself)?
- Is the smart tier's fast speed (e.g. Opus fast mode, $8/$40 per MTok, up to 2.5× output speed) worth it for TTA?
