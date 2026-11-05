# Vizzo: docs

A desktop app (Electron) for talking to your web app while pointing at it: the project's page in a browser pane, and a voice chat sidebar that works out which element you meant (cursor + word timestamps) and hands hard questions and code changes to a stronger model.

| Doc | What's in it |
|---|---|
| [PRD.md](PRD.md) | Why, goals, non-goals, how it works, requirements, success metrics |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Stack, folder layout, **contracts** (WS protocol, adapter interfaces), timing model, pointing algorithms |
| [API-NOTES.md](API-NOTES.md) | Vendor API facts and prices: ✅ confirmed vs ⚠️ to verify |
| [PLAN-threads.md](PLAN-threads.md) | Element threads: decisions, server, page, milestones |
| [PLAN-drawing.md](PLAN-drawing.md) | Drawing annotations: interaction, data contract, implementation and validation |
| [BENCH-tts.md](BENCH-tts.md), [BENCH-claude-backends.md](BENCH-claude-backends.md) | Benchmark results |
| [TASKS.md](TASKS.md) | The original build plan (T0–T11), kept as history |

## Running it

```sh
npm install
npm run dev                 # the Electron app (browser pane + voice sidebar). Choose a project folder in the toolbar
                            # (Settings can scan the harnesses before that), and add the API keys in Settings → API keys (there is no .env file).
npm run dev:fake            # same, but every vendor is faked (tones + canned text): try the UI with no keys
npm run setup:local-tts     # optional: Kokoro + Piper voices (macOS TTS needs nothing)
npm run setup:local-stt     # optional: Parakeet, Moonshine, WhisperKit for Speech → On-device (Apple needs nothing)
```

The chat is the sidebar: each turn is classified question / task / clarify / answer with a time estimate. Short tasks get spoken progress lines while the solver works; long ones run as background jobs that are announced when done. Hold Control or the button to talk, or turn on Always listen. Press Control while it talks to interrupt, Esc to stop. Ctrl+M turns on comment mode. Both keys can be changed in Settings → Keyboard. Point at the page in the browser pane. History is kept per connection; "New conversation" resets it. Chat turns are saved to `results/chat-*.jsonl`.

Checks: `npm run typecheck`, `npm test`, `npm run smoke:{scribe,tts,claude,e2e}` (each SKIPs without its keys), `npm run smoke:e2e -- --fake` (whole server path, fake vendors), `npm run smoke:chat -- a.wav b.wav c.wav` (real multi-turn chat).

### Drawing feedback

Click the pencil beside Comment to capture the current page. Use Pen, Arrow, Box or Ellipse, then type or hold Control to dictate the request. Send submits the image and element details together; with Instant off, it joins the feedback queue. Click a message's drawing thumbnail to reopen its original image.

Hover over the circle before Pen to open eight drawing colors above it. The stroke control beside it opens normal, dashed and dotted styles plus five widths (1.5, 3, 5, 8 and 12 px); the original 3 px stroke is level 2. Changes apply to new marks; existing marks retain their color, width and style. The active drawing tool uses the app's blue brand styling. Escape closes an open picker first. Keyboard users can focus either control and press Enter, Space or an arrow to open it.

Choose **Select** to click and drag a mark. Cmd/Ctrl-click adds or removes marks from the selection; Cmd/Ctrl+A selects all marks while Select is active. Arrow keys nudge selected marks by 1 px (Alt+arrow: 10 px). Moving marks preserves their numbers, styles and voice links. Cmd/Ctrl+Z undoes a drawing action; Cmd/Ctrl+Shift+Z redoes it. Delete removes the selection, or the latest mark when nothing is selected. Clear is undoable. Escape or toggling Draw off returns to browsing and discards the draft. Each entry into Draw captures the current page and starts a fresh drawing. The captured page stays fixed while drawing, including when the window is resized.

One long recording or several voice notes can describe the same drawing. Draw while speaking for automatic timing suggestions, or select numbered marks before speaking to link them explicitly. The **Voice links** panel shows the spoken phrases and associated marks. **Edit links** lets you choose several marks, use the canvas selection, or clear a link; clicking a phrase selects its text for correction. When a speech provider has no word timestamps, matching uses the recording interval and leaves ambiguous phrases unlinked. Links and note boundaries travel with the submitted drawing. Dictation stays with its original form even if you move marks or focus another control while recording.

`npm run smoke:drawing` runs the actual sandboxed Electron page preload against a local fixture with no model or microphone calls. It exercises four tools, editing, typing, dictation insertion, form state, drawing re-entry, resizing, image export and preview lifecycle. Screenshots are written to `results/drawing-smoke/`.

## Key decisions (short)
- Push-to-talk first (Always listen is an option). Benchmark numbers come from replaying recorded WAVs headless.
- Every vendor call goes through one local Node server WebSocket. Keys never reach the browser.
- t = 0 is key release. "Played" means the first audio sample actually rendered, not bytes received.
- Pointing needs word timestamps, so it comes from Scribe. That's one reason the pipeline (Scribe → router → TTS) is the only approach left: OpenAI Realtime (A) and Realtime + Scribe (C) were removed on 2026-10-17.
- Phase 2 (not this repo yet): an OS-wide macOS menu-bar app (Accessibility API + ScreenCaptureKit) using the same pointing algorithms.
