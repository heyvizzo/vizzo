# Realtime Voice: docs

A desktop app (Electron) for talking to your web app while pointing at it: the project's page in a browser pane, and a voice chat sidebar that works out which element you meant (cursor + word timestamps) and hands hard questions and code changes to a stronger model.

| Doc | What's in it |
|---|---|
| [PRD.md](PRD.md) | Why, goals, non-goals, how it works, requirements, success metrics |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Stack, folder layout, **contracts** (WS protocol, adapter interfaces), timing model, pointing algorithms |
| [API-NOTES.md](API-NOTES.md) | Vendor API facts and prices: ✅ confirmed vs ⚠️ to verify |
| [PLAN-threads.md](PLAN-threads.md) | Element threads: decisions, server, page, milestones |
| [BENCH-tts.md](BENCH-tts.md), [BENCH-claude-backends.md](BENCH-claude-backends.md) | Benchmark results |
| [TASKS.md](TASKS.md) | The original build plan (T0–T11), kept as history |

## Running it

```sh
npm install
npm run dev                 # the Electron app (browser pane + voice sidebar). Choose a project folder in the toolbar,
                            # and add the API keys in Settings → API keys (there is no .env file).
npm run dev:fake            # same, but every vendor is faked (tones + canned text): try the UI with no keys
npm run setup:local-tts     # optional: Kokoro + Piper voices (macOS TTS needs nothing)
npm run setup:local-stt     # optional: Parakeet, Moonshine, WhisperKit for Speech → On-device (Apple needs nothing)
```

The chat is the sidebar: each turn is classified question / task / clarify / answer with a time estimate. Short tasks get spoken progress lines while the solver works; long ones run as background jobs that are announced when done. Hold Shift or the button to talk, or turn on Always listen. Press Shift while it talks to interrupt, Esc to stop. Point at the page in the browser pane. History is kept per connection; "New conversation" resets it. Chat turns are saved to `results/chat-*.jsonl`.

Checks: `npm run typecheck`, `npm test`, `npm run smoke:{scribe,tts,claude,e2e}` (each SKIPs without its keys), `npm run smoke:e2e -- --fake` (whole server path, fake vendors), `npm run smoke:chat -- a.wav b.wav c.wav` (real multi-turn chat).

## Key decisions (short)
- Push-to-talk first (Always listen is an option). Benchmark numbers come from replaying recorded WAVs headless.
- Every vendor call goes through one local Node server WebSocket. Keys never reach the browser.
- t = 0 is key release. "Played" means the first audio sample actually rendered, not bytes received.
- Pointing needs word timestamps, so it comes from Scribe. That's one reason the pipeline (Scribe → router → TTS) is the only approach left: OpenAI Realtime (A) and Realtime + Scribe (C) were removed on 2026-10-17.
- Phase 2 (not this repo yet): an OS-wide macOS menu-bar app (Accessibility API + ScreenCaptureKit) using the same pointing algorithms.
