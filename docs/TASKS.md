# Tasks: multi-agent work breakdown

Each task is sized for one agent working in its own git worktree. Contracts are in `ARCHITECTURE.md`. If a task needs a contract change, it edits `ARCHITECTURE.md` and the `shared/` types **in the same commit** and says so in its report.

## Dependency graph

```
T0 scaffold ──┬──▶ T2 audio I/O (web) ─────────────┐
              ├──▶ T3 Scribe adapter ──┐            │
T1 API verify ┼──▶ T4 Realtime adapter ┼─▶ T7 orchestrators ─▶ T8 lab UI ─▶ T11 benchmark + REPORT
              ├──▶ T5 TTS adapter ─────┤            │                         ▲
              ├──▶ T6 Claude adapter ──┘            │                         │
              └──▶ T9 cursor lab (web + shared/pointing.ts) ─▶ T10 fixtures ──┘
```

- **Wave 1 (sequential, short):** T0, then T1. T1 may run alongside T0 because it only edits `docs/API-NOTES.md`.
- **Wave 2 (parallel):** T2, T3, T4, T5, T6, T9.
- **Wave 3:** T7 (needs T3–T6), then T8 (needs T2, T7). T10 needs T2 and T9.
- **Wave 4:** T11.

## Rules for every task
- TypeScript strict, ESM. No vendor keys in `web/`.
- Each server adapter ships with `scripts/smoke-<name>.ts`, runnable as `npm run smoke:<name>`, that exercises the real API with keys from `.env` and prints the timing marks. If keys are missing, it exits with code 0 and prints a clear SKIP.
- Pure logic (`shared/pointing.ts`, metric derivation, clock sync, WAV parsing) gets unit tests with `vitest`.
- Use the exact model IDs from `PRD.md` §8. Don't invent API fields: anything marked ⚠️ in `API-NOTES.md` must be confirmed by T1 first or checked by the task itself (and recorded in `API-NOTES.md`).
- **Finishing a task means:** `npm run typecheck` and `npm test` pass, the smoke script runs (or SKIPs without keys), and the agent reports what it verified and what it couldn't.

---

### T0: Scaffold
**Goal:** a repo that runs and that every other task builds on.
- `package.json` scripts: `dev` (server and Vite together), `build`, `typecheck`, `test`, `smoke:*`.
- Deps: `vite`, `typescript`, `tsx`, `ws`, `@types/ws`, `dotenv`, `@anthropic-ai/sdk`, `vitest`, `concurrently`.
- Folder layout as in ARCHITECTURE §1, with stub files that export the interfaces.
- `shared/protocol.ts`, `shared/marks.ts`, `shared/config.ts` written **in full** from ARCHITECTURE §3 and §5. `RunConfig` = `{approach: "realtime"|"pipeline"|"hybrid", realtimeModel, opusFast: boolean, routerMode: "forced"|"auto", hybridWaitMs: number, ttsModel, prewarm: boolean, preMs: number, postMs: number}`.
- Server: HTTP on port 8787, `/ws` accepts connections, answers `ping` with `pong`, and logs messages. Vite proxies `/ws` and `/api`.
- `.env.example`, `.gitignore` (`.env`, `results/`, `node_modules`, `dist`).
- Web: `index.html` and `cursor.html` with a nav between them; `web/ws.ts` with clock sync (ARCHITECTURE §5) that shows RTT and offset on the page.
**Accept:** `npm run dev` serves both pages, the WS connects, RTT/offset are displayed, and typecheck passes.

### T1: API verification spike
**Goal:** remove every ⚠️ in `API-NOTES.md`.
- Read the vendor docs (links in API-NOTES "Sources"). Where keys exist, open real sockets with throwaway scripts in `scripts/probe-*.ts` and log the actual event names and payloads.
- Confirm: OpenAI Realtime session fields, client/server event names, function-call flow, and `usage` location; Scribe commit behavior and timestamp semantics; the ElevenLabs TTS WebSocket shape, whether `eleven_v4_turbo` works over it, and multi-context support.
- Update `API-NOTES.md` with exact JSON examples, replacing ⚠️ with ✅ or a documented workaround.
**Accept:** no ⚠️ left, or each remaining one has a written workaround. Each probe script prints a captured sample event.

### T2: Browser audio I/O
**Goal:** reliable capture, playback and replay with correct timestamps.
- `capture-worklet.ts`: mic → mono → resample to 24 kHz → PCM16 little-endian frames of 20 ms. Report the `performance.now()` of the **first captured sample** of each turn (used as `tAudioStart`).
- `player-worklet.ts`: queues PCM16 24 kHz frames per segment (`ack` and `answer`), plays them gaplessly, and reports the time the first non-silent sample of each segment was played, converted to `performance.now()` with `getOutputTimestamp()`. That time is sent as `audio.played`.
- `replay.ts`: load a WAV fixture (any sample rate) → resample → feed frames to the same output path **at real-time pace**; replay the paired cursor trail by dispatching the samples to the cursor stream with matching timing.
- Push-to-talk: hold Space or an on-screen button. Send `turn.start` on press and `turn.release` on release.
- `web/audio/record.ts`: record a mic turn to WAV (used by T10).
**Accept:** a loopback test page (`/audio-test`) round-trips mic → server echo → playback, and shows capture-to-played delay. Unit tests cover the resampler and the WAV parser.

### T3: Scribe adapter (`server/adapters/scribe.ts`)
Implement `openScribe` per ARCHITECTURE §4 and API-NOTES. One session per turn, `commit_strategy=manual`, `include_timestamps=true`, `audio_format=pcm_24000`. Emits `stt.firstPartial` and `stt.final`. `final()` resolves on the timestamped commit, with a 3 s timeout fallback to plain `committed_transcript` and empty words. Filter words to `type === "word"`.
**Accept:** `npm run smoke:scribe` streams `fixtures/smoke/hello.wav` (bundled; generate one with TTS or `say` if needed), prints words with start/end, and prints the release → final latency.

### T4: OpenAI Realtime adapter (`server/adapters/openaiRealtime.ts`)
Implement `openRealtime` per ARCHITECTURE §4 and the confirmed shapes from T1. Push-to-talk (`turn_detection` off), PCM16 24k in/out, a voice set by config, the `ask_opus` tool. `commitAndRespond(extraContext)` adds a text context item before `response.create`. Emits `llm.request`, `llm.firstToken`, `llm.toolCall`, `ack.ttsFirstByte`. Captures `usage` from the response-done event.
**Accept:** the smoke script sends `hello.wav`, receives audio (saved to `out/realtime-reply.wav`), and prints marks. A second smoke case forces a tool call and returns a fake result.

### T5: ElevenLabs TTS adapter (`server/adapters/elevenTts.ts`)
Implement `openTts` per ARCHITECTURE §4 and the confirmed shapes from T1. Streams text in and PCM16 24k out. `flush()` ends a segment. Emits `ack.ttsFirstByte` / `answer.ttsFirstByte` (the segment name is passed in). Counts characters for cost. If T1 finds v4 Turbo unsupported on the WebSocket, implement the HTTP-per-sentence fallback behind the same interface.
**Accept:** the smoke script streams a sentence word by word, saves `out/tts.wav`, and prints text-in → first-byte latency for `eleven_v4_turbo` and `eleven_flash_v2_5`.

### T6: Claude adapter (`server/adapters/claude.ts` + `server/prompts/`)
Implement `routeWithHaiku` and `solveWithOpus` per ARCHITECTURE §4 and the API-NOTES Anthropic section.
- Router prompt: a very short spoken acknowledgment and a precise delegated question that includes the pointing context. Tool `ask_opus` with input `{ack: string, question: string}`, `eager_input_streaming: true`. Stream `ack` deltas out via `onSpokenDelta` while the input streams in. In `auto` mode Haiku may answer simple questions directly in text (also spoken).
- Opus prompt: answer about the fixture codebase in `server/fixtures-context/` (write a small realistic one: the cursor-lab demo page's HTML/CSS/TS plus a `DECISIONS.md` and a short fake Claude Code session transcript explaining why the grid, sticky header and CTA color were chosen). Output format: first line `SPOKEN: <1–3 sentences>`, then a blank line, then the detailed answer.
- Prompt caching on the system prompt and fixture context. Log cache reads.
- Opus fast mode behind `fast: boolean`, falling back to standard on a 429. Refusal handling per API-NOTES.
**Accept:** `npm run smoke:claude` runs the router (both modes) and Opus (fast off/on) on U3's transcript, prints marks, and shows `cache_read_input_tokens > 0` on the second run.

### T7: Orchestrators (`server/orchestrators/*`, `server/session.ts`, `server/results.ts`)
Implement A, B and C per ARCHITECTURE §7 on top of the T3–T6 interfaces. Session routing by `RunConfig.approach`. Server-side pointing resolution with `shared/pointing.ts` (from T9; until it lands, stub it to return `[]`). Builds the `RunRecord`, computes cost from usage × API-NOTES prices, sends `turn.done`, and appends to `results/YYYY-MM-DD.jsonl`. Pre-warm per the config flag. A `turn.cancel` cleans up every socket.
**Accept:** a headless script `npm run smoke:e2e` replays `hello.wav` through all three approaches over the real `/ws` and prints one `RunRecord` per approach with every applicable mark filled in.

### T8: Latency lab UI (`web/lab/*`)
Controls for `RunConfig` and the input source (mic or fixture), plus an N-runs button with a cooldown. Live display: transcript, pointing targets, voice text, Opus text. A per-turn **waterfall** (horizontal bars from `release` for each mark/stage, segments colored by vendor). A **results table** with p50/p90/mean per approach × metric (ttfa, tta, stt, llmFirst, toolCall, opusFirst, opusSpoken, opusTotal, ttsFirst, costUsd). Filter by fixture. Export JSON/CSV. Load past runs from `GET /api/results`.
**Accept:** running all three approaches 5× on one fixture fills the table and waterfall with no missing marks for that approach's path.

### T9: Cursor lab (`web/cursor/*`, `shared/pointing.ts`)
Covers FR7–FR13 in PRD. The demo page has `data-source` and `data-label` on every target (keep it in sync with the T6 fixture context: same page). The pointer sampler is per ARCHITECTURE §3 `CursorSample`. The 4 resolvers in `shared/pointing.ts` have unit tests. Timeline canvas: cursor speed line, word spans, pointing windows, picked samples. Overlay highlights per algorithm. Sliders for `preMs`/`postMs`. Labeling mode: click the correct element for each pointing word. Accuracy table per algorithm across saved sessions. Uses `openScribe` through the server: add a `cursor-only` approach that does STT + resolution with no LLM.
**Accept:** say "move this over there" while pointing at two cards; both cards are highlighted by at least the `dwell` resolver; save, label and score the session.

### T10: Benchmark fixtures
Record U1–U5 (PRD §5) with the cursor lab: WAV + cursor trail + labels in `fixtures/utterances/`. Add a `fixtures/README.md` describing each one and the expected targets.
**Accept:** each fixture replays in the latency lab and the cursor lab, and the resolver accuracy table runs over them.

### T11: Benchmark and report
Run every fixture × approach × key config (realtime full vs mini, routerMode forced vs auto, Opus fast on/off, hybridWaitMs 0/400) for N=10, warm. Write `docs/REPORT.md`: method, network RTT, p50/p90 tables for TTFA and TTA, stage breakdowns, resolver accuracy, cost per turn, surprises, and a recommendation for the product architecture. Commit the raw `results/*.jsonl` used, as `docs/report-data/`.
**Accept:** every number in the report traces back to the committed data, and the recommendation names a concrete approach and config.
