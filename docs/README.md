# Realtime Voice Latency Lab: docs

A local web app that measures three voice architectures for a "talk to your app while pointing at it" tool, plus a lab for turning cursor position + word timestamps into the element the user meant.

| Doc | What's in it |
|---|---|
| [PRD.md](PRD.md) | Why, goals, non-goals, the three approaches, requirements, success metrics |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Stack, folder layout, **contracts** (WS protocol, adapter interfaces), timing model, pointing algorithms |
| [API-NOTES.md](API-NOTES.md) | Vendor API facts and prices: ✅ confirmed vs ⚠️ to verify |
| [TASKS.md](TASKS.md) | Work packages T0–T11, dependency graph, acceptance criteria |
| REPORT.md | *(written by T11)* benchmark results and recommendation |

## Running it

```sh
npm install
cp .env.example .env        # add ANTHROPIC_API_KEY, OPENAI_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID
npm run dev                 # server :8787 + Vite :5173 → http://localhost:5173
npm run dev:fake            # same, but every vendor is faked (tones + canned text): try the UI with no keys
```

Pages: `/` latency lab, `/cursor.html` cursor lab, `/audio-test.html` mic → server echo → playback.

Checks: `npm run typecheck`, `npm test`, `npm run smoke:{scribe,realtime,tts,claude,e2e}` (each SKIPs without its keys), `npm run smoke:e2e -- --fake` (whole server path, fake vendors).

Fixtures: record U1–U5 in the cursor lab (Save files), drop them in `fixtures/utterances/`, and they show up in the latency lab's fixture picker.

## Running a multi-agent build

1. **Keys:** `cp .env.example .env` (after T0) and fill in `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`. Without keys, everything still builds and the smoke tests SKIP.
2. **Wave 1:** one agent does **T0 scaffold**, and one does **T1 API verification** in parallel (T1 only touches `docs/API-NOTES.md` and `scripts/probe-*`). Merge both before wave 2, since the adapters depend on T1's confirmed shapes.
3. **Wave 2 (parallel, one worktree each):** T2 audio I/O, T3 Scribe, T4 Realtime, T5 TTS, T6 Claude, T9 cursor lab.
4. **Wave 3:** T7 orchestrators, then T8 lab UI. T10 fixtures once T2 and T9 are merged (T10 needs you at the mic: recording is manual).
5. **Wave 4:** T11 benchmark + REPORT.

Suggested kickoff prompt for each agent:

> You are implementing task **Tn** from `docs/TASKS.md` in this repo. Read `docs/PRD.md`, `docs/ARCHITECTURE.md` and `docs/API-NOTES.md` first. Build only your task and stick to the contracts in ARCHITECTURE.md. If you must change a contract, update ARCHITECTURE.md and `shared/` in the same commit and say so. Done means: typecheck and tests pass, your smoke script runs (or SKIPs without keys), and your final report lists what you verified against real APIs and what you couldn't.

The orchestrator (lead agent) reviews each task against its **Accept** line before merging, and resolves contract conflicts in ARCHITECTURE.md.

## Key decisions (short)
- Push-to-talk everywhere. Replay of recorded fixtures is what the benchmark numbers come from.
- Every vendor call goes through one local Node server WebSocket. Keys never reach the browser.
- t = 0 is key release. "Played" means the first audio sample actually rendered, not bytes received.
- Pointing needs word timestamps, so it comes from Scribe. That's why approach C (realtime voice + Scribe in parallel) exists.
- Phase 2 (not this repo yet): an OS-wide macOS menu-bar app (Accessibility API + ScreenCaptureKit) using the same pointing algorithms.
