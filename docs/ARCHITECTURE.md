# Architecture

Read `PRD.md` first. This doc defines the **contracts** that parallel workers build against. If you need to change a contract, update this file in the same change.

## 1. Stack and layout

- **Language:** TypeScript everywhere. Node ≥ 22 (dev machine has v26), npm.
- **App:** Electron (`electron/`): a browser pane on the left (the user's project page) and the voice chat as a sidebar on the right. The voice server runs in a utilityProcess on a free local port once a project folder is chosen.
- **Web:** Vite + vanilla TS, no framework. One page, `chat.html` (the sidebar). The latency lab (`/`) and cursor lab (`/cursor`) pages were removed.
- **Server:** Node + `ws`, run with `tsx`. API keys come from the Settings window (stored in the app's settings file and handed to the server; `npm run dev:server` and the scripts read the same file with `loadDesktopEnv`). There is no `.env`.
- **Vendor SDKs:** `@anthropic-ai/sdk` for Claude. ElevenLabs uses raw WebSockets (`ws`), with no extra SDKs.
- **Dev:** `npm run dev` runs the server (port 8787) and Vite (port 5173) together. Vite proxies `/ws` and `/api` to the server.

```
realtime-voice/
├─ docs/                      # this folder
├─ shared/
│  ├─ protocol.ts             # browser↔server message types (§3)
│  ├─ marks.ts                # timing mark names (§5)
│  └─ config.ts               # RunConfig type + defaults
├─ electron/                  # app shell: main process, preloads (sidebar + page), settings, permissions
├─ server/
│  ├─ index.ts                # http + ws entry, session routing
│  ├─ session.ts              # one browser connection = one Session
│  ├─ clock.ts                # server-side mark stamping
│  ├─ adapters/               # STT (Scribe, OpenRouter), TTS (ElevenLabs, OpenAI, Fish, macOS, Kokoro/Piper), harnesses (router + solver)
│  ├─ orchestrators/
│  │  ├─ pipeline.ts          # the voice assistant (STT → router → TTS, solver for hard tasks)
│  │  ├─ cursorOnly.ts        # STT + pointing only (dictating into a comment)
│  │  ├─ jobs.ts, fillers.ts  # background jobs, progress lines
│  ├─ threads/                # element threads: store, runner, speaking floor, notice policy
│  ├─ prompts/                # system prompts as .md files
│  ├─ project.ts              # the project folder (PROJECT_DIR): page files for the browser, codebase for the solver
│  └─ results.ts              # append runs to results/*.jsonl
├─ web/
│  ├─ chat.html, chat/        # the sidebar: conversation, settings, costs, prompt debug view
│  ├─ audio/                  # mic capture, playback, push-to-talk, always-listen VAD
│  ├─ ws.ts                   # typed client for shared/protocol.ts
│  └─ cursor/                 # in the page: pointer sampler, page context, thread markers, comment overlay
├─ tools/                     # on-device speech helpers (mactts, macstt, localtts, localstt)
├─ scripts/                   # smoke tests (smoke-*.ts), benchmarks (bench-*.ts), local TTS/STT setup
├─ fixtures/smoke/            # WAVs replayed by the smoke and bench scripts
├─ results/                   # *.jsonl (gitignored)
└─ package.json
```

## 2. Data flow

```
Browser                                   Server                                Vendors
───────                                   ──────                                ───────
mic/replay → capture-worklet ─PCM16 24k──▶ Session ──▶ orchestrator (pipeline)
pointer sampler ─cursor samples──────────▶   │           ├─ scribe.ts ─────────▶ ElevenLabs STT WS
player-worklet ◀────────PCM16 24k──────────  │           ├─ claude.ts ─────────▶ Anthropic Messages (stream)
waterfall UI ◀──────────marks/events───────  │           └─ elevenTts.ts ──────▶ ElevenLabs TTS WS
```

- **Audio up:** the browser always sends **PCM16 mono 24 kHz little-endian** as binary WS frames. Scribe accepts `audio_format=pcm_24000`, so we skip resampling.
- **Audio down:** every TTS path delivers **PCM16 mono 24 kHz**: OpenAI output audio, and ElevenLabs with `output_format=pcm_24000`. One player handles both.

## 3. Browser ↔ server protocol (`shared/protocol.ts`)

There is one WebSocket at `/ws`. Binary frames carry audio. Text frames are JSON with a `type` field.

```ts
// ── client → server ──────────────────────────────
type ClientMsg =
  | { type: "hello"; clientNow: number }                  // starts clock sync
  | { type: "ping"; id: number; clientNow: number }
  | { type: "clock.sync"; rttMs: number; offsetMs: number }  // result of sync, so the server stores marks in client time
  | { type: "turn.start"; turnId: string; config: RunConfig; tPress: number; fixtureId?: string }
  | { type: "cursor.samples"; turnId: string; samples: CursorSample[] } // batched every ~100ms
  | { type: "turn.audioStart"; turnId: string; tAudioStart: number } // client time of first captured sample (§6)
  | { type: "turn.context"; turnId: string; clicks: PageClick[]; selection: PageSelection | null } // right before turn.release
  | { type: "turn.release"; turnId: string; tRelease: number }
  | { type: "audio.played"; turnId: string; segment: "ack" | "answer"; tPlayed: number }
  | { type: "turn.cancel"; turnId: string }
  | { type: "echo"; on: boolean };            // debug: echo binary audio when no turn is active (/audio-test)
// binary frame while a turn is active: raw PCM16 24k audio for the active turn

// ── server → client ──────────────────────────────
type ServerMsg =
  | { type: "pong"; id: number; clientNow: number; serverNow: number }
  | { type: "mark"; turnId: string; name: MarkName; serverNow: number; meta?: Record<string, unknown> }
  | { type: "stt.partial"; turnId: string; text: string }
  | { type: "stt.final"; turnId: string; text: string; words: Word[] }
  | { type: "pointing.resolved"; turnId: string; targets: PointingTarget[] }
  | { type: "voice.text"; turnId: string; delta: string }        // what the voice layer says
  | { type: "solver.text"; turnId: string; delta: string }         // full solver answer, streamed
  | { type: "audio.segment"; turnId: string; segment: "ack" | "answer"; state: "start" | "end" }
  // binary frame: PCM16 24k audio for the active turn's current segment
  | { type: "turn.done"; turnId: string; run: RunRecord }
  | { type: "error"; turnId?: string; source: string; message: string };

interface Word { text: string; start: number; end: number }           // seconds from turn audio start
interface CursorSample {
  t: number; x: number; y: number; scrollX: number; scrollY: number;
  elementPath: string | null;   // stable CSS path of the most specific meaningful element under the pointer (see below)
  dataSource: string | null;    // that element's own [data-source], else the nearest ancestor's, "file:line"
  label: string | null;         // that element's own short text / name (a card title, a th), else its data-label
  container?: string | null;    // data-label of the enclosing labeled component (card, table, form) when different
}
interface ElementRef { elementPath: string | null; dataSource: string | null; label: string | null; container?: string | null }
interface PageClick extends ElementRef { t: number; x: number; y: number }      // client clock, viewport px
interface PageSelection extends ElementRef { t: number; text: string }          // latest non-empty selection in the turn
interface PointingTarget { word: string; wordStart: number; algorithm: string; sample: CursorSample | null }
```

**Element description** (`web/cursor/dom.ts` `describeElement(hit, root)`, used for cursor samples, clicks and selections). The target is the most specific *meaningful* element at or above the hit element: h1–h6, th/td/caption, button, a, label/legend, input/select/textarea/option, img, li/dt/dd, p, blockquote, summary, figcaption, any element with its own `data-label`/`data-source`, or a div/span with text of its own. Bare wrappers walk up to the nearest such element, never past `root` (none → the hit element, unlabeled). So hovering a card's `<h3>` reports the `<h3>` ("Live queries", container "Card: Live queries"), not the card; a table heading reports the `<th>` (container "Pricing table"); a gap inside a card reports the card itself. `label` = aria-label, else the element's own whitespace-collapsed text (≤ 60 chars, "…"), else its data-label; controls/images use aria-label → alt → data-label → title → placeholder; components (article, section, tr…) reached by walking up use their data-label, never their whole text.

**Page context** (`web/cursor/pageContext.ts` `createPageContextRecorder(root)`): `start(tPress)` on press, `stop()` on release. A click is a pointerdown→pointerup inside `root` that moved ≤ 6 px (a drag is a text selection, not a click), plus keyboard activations; the same element within 800 ms counts once. The selection is the latest non-empty one whose anchor and focus are inside `root` (`selectionchange`), and a selection still active at `stop()` counts even if it was made before the press. The client sends `turn.context` right before `turn.release`.

The canonical types live in `shared/protocol.ts`. **Server-side bookkeeping:** the server converts every server mark to client time using the `clock.sync` offset and stores it in `RunRecord.marks`. After the orchestrator finishes, it waits (up to 3 s) for an `audio.played` for every segment it sent, then sends `turn.done` and appends the run to `results/`.

Only one turn is active at a time. Binary frames always belong to the active turn. Audio sent after `turn.release` is ignored.

### Browser audio API (`web/audio/*`)

Used by the Chat sidebar: `startCapture({onFrame, preRollMs?}) → CaptureHandle` (`capture.ts`), `createPlayer() → Player` with `startSegment/push/endSegment/onPlayed/reset` (`player.ts`), `bindPushToTalk(...)` (`ptt.ts`), the always-listen VAD (`vad.ts`, level from `level.ts`). Frames are 20 ms PCM16 24 kHz `Int16Array`s.

Implementation notes: one shared `AudioContext` at the native rate plus one mic stream (`context.ts`, which also exports `warmUpAudio()`; call it from a user gesture before the first turn so the permission prompt and context start aren't counted in a turn). Pure helpers live in `dsp.ts` (windowed-sinc resampler, framing, PCM conversion) and `timing.ts` (context time ↔ `performance.now()`). `tAudioStart` is the estimated capture time of the first sample delivered after `startCapture`, so it can be a few ms *before* the key press (the mic pipeline buffers audio). `onPlayed` fires for the first sample above about −60 dBFS in each `startSegment()`. Audio pushed before any `startSegment()` plays but is never reported.

## 4. Server adapter interfaces

The interfaces are in `server/adapters/types.ts` . Additions over the sketch below: `openTts` takes `segment: "ack" | "answer"` (which `*.ttsFirstByte` mark to emit) and `TtsStream` exposes `chars`; `SttStream` exposes `seconds` (audio seconds sent, feeds `usage.scribeSeconds`); `routeTurn` also returns `usage`. Orchestrators implement `Orchestrator = (ctx: TurnContext) => TurnHandlers` from `server/orchestrators/types.ts`, and `server/session.ts` routes to them by `config.approach`. `server/cost.ts` computes `costUsd`.

**T7 additions (additive):**
- `routeTurn`'s `onSpokenDelta(d, kind)` gets `kind: "ack" | "answer"` ("ack" = the `ack` field of an `ask_solver` call, "answer" = a direct text answer in auto mode), and an optional `onSpokenEnd("ack")` fires as soon as the ack field is complete (before `question` is written), so the pipeline flushes the ack TTS early.
- `TurnContext.connection: ConnectionCache` (`get/set(key, value, dispose?)/delete`): per-browser-connection state, disposed when the WebSocket closes. Used for background jobs.
- `TurnResult.ackIsAnswer?: boolean`: see §7 A. The Session then renames `ack.ttsFirstByte`/`ack.played` to `answer.*` in the RunRecord (`markMeta[...].relabeledFrom`).
- Each orchestrator module exports a factory `createXOrchestrator(deps: OrchestratorDeps)` (deps = the adapter functions + `voiceId?`, `turnTimeoutMs?`); the default export uses the real adapters (`server/orchestrators/deps.ts`). Fakes with the same marks live in `server/orchestrators/fakes.ts` (tests, `smoke:e2e --fake`).
- `new Session(ws, {orchestrators?, persist?})` and `startServer(port, {orchestrators?, persist?, quiet?})` exported from `server/index.ts` (port 0 = random); `tsx server/index.ts` still listens on `PORT`/8787.

Orchestrators depend **only** on these interfaces, so each adapter can be built and smoke-tested on its own. Each adapter emits marks through the injected `mark()` function.

```ts
type Mark = (name: MarkName, meta?: Record<string, unknown>) => void;

interface SttStream {                          // server/adapters/scribe.ts
  pushAudio(pcm24k: Buffer): void;
  commit(): void;                              // push-to-talk release
  onPartial(cb: (text: string) => void): void;
  final(): Promise<{ text: string; words: Word[] }>;  // resolves on committed_transcript_with_timestamps
  close(): void;                               // idempotent
  readonly seconds: number;                    // audio seconds sent, for cost (T3 addition)
}
function openScribe(opts: { mark: Mark; keyterms?: string[] }): Promise<SttStream>;
// T3: resolves when the socket is OPEN; audio/commit pushed before `session_started` is buffered and flushed then.
// stt.final meta: { timestamped, words, commitToFinalMs, plainToTimestampedMs?, fallback?, error? }.

interface TtsStream {                          // server/adapters/elevenTts.ts
  pushText(delta: string): void;               // streamed text in
  flush(): void;                               // end of utterance: force generation
  onAudio(cb: (pcm24k: Buffer) => void): void;
  done(): Promise<void>;
  close(): void;
}
function openTts(opts: { mark: Mark; voiceId: string; model: "eleven_v4_turbo" | "eleven_flash_v2_5" }): Promise<TtsStream>;
// T1 finding: eleven_v4_turbo is only on the Text-to-Dialogue WebSocket (wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input),
// a different protocol from TTS stream-input (used for eleven_flash_v2_5). elevenTts.ts switches protocol on `model`.
// End-of-segment is only signaled after close, so it's ONE socket PER SEGMENT: flush() = flush + close; done() resolves on final/close.
// Pre-warmed v4 dialogue sockets hold capacity from a separate pool while open; pre-warm at most one (see API-NOTES).

// server/adapters/claude.ts
function routeTurn(opts: {
  mark: Mark; transcript: string; pointing: PointingTarget[]; mode: "forced" | "auto";
  onSpokenDelta: (d: string) => void;          // text to speak right away (ack, or a direct answer in auto mode)
}): Promise<{ delegate: null | { question: string } }>;

function solveTask(opts: {
  mark: Mark; question: string; pointing: PointingTarget[]; fast: boolean;
  onSpokenLine: (line: string) => void;        // fires once the SPOKEN: line is complete
  onDelta: (d: string) => void;                // full answer stream
}): Promise<{ text: string; usage: unknown }>;
```

### Claude settings (read `API-NOTES.md` §Claude before writing claude.ts)
- **Provider:** OpenRouter's Anthropic-compatible endpoint when `OPENROUTER_API_KEY` is set (model IDs `anthropic/claude-*-5.5`, no `fallbacks`, fast mode not honored). See API-NOTES "Live checks".
- **Router** (Anthropic API, default `claude-haiku-5-5`): `output_config: {effort: "low"}`, streaming. Don't send `temperature`/`top_p`/`top_k` (non-default values are a 400). Forced mode: `tool_choice: {type: "tool", name: "ask_solver"}` (Haiku 5.5 accepts it and skips thinking). Put the spoken acknowledgment **inside the tool input** (`ack` field) so it can stream out before the call finishes; use `eager_input_streaming: true` on the tool and validate the parsed input.
- **Solver** (Anthropic API, default `claude-opus-5-5`): streaming, `output_config: {effort: "medium"}` (set it explicitly). Thinking can't be disabled, so don't send `thinking: disabled`. No forced `tool_choice`. Fast mode: `client.beta.messages.stream({... speed: "fast", betas: ["fast-mode-2026-02-01"]})`. Add refusal fallbacks (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) and check `stop_reason` before reading content.
- Cache the system prompt and the fixture codebase context with `cache_control` so repeated benchmark runs hit the cache, and log `usage.cache_read_input_tokens`.

### Model tiers: a harness, model, level and speed per tier (`RunConfig.llm`)
Two tiers, each `{ provider, model, level?, speed? }` (model `""` = the harness's default): **fast** = the router and the progress lines, **smart** = the solver (hard questions and change requests). `provider` is a harness, or on the fast tier only a model API called directly (`adapters/llmApi.ts`: OpenRouter, Fireworks, Cerebras, OpenAI and Z.ai over OpenAI-style streamed Chat Completions, Anthropic through `@anthropic-ai/sdk`; keys from Settings). An API call is one HTTP request with the role's system prompt and the turns as real messages (a harness gets them flattened), no tools and nothing to warm; reasoning text is dropped, only the answer streams into the router's parser. Its level maps to each API's own field (`reasoning_effort`, OpenRouter `reasoning`, Z.ai `thinking`, Anthropic `thinking` + `output_config.effort`); "off" turns reasoning off and is where a fast tier starts when the model can. API models and levels come from the models.dev catalog. The solver stays on a harness (it needs file tools): `llmOf` drops an API on the smart tier. The project's source is never sent inline. The Chat page picks each tier (harness, model, level, speed); `GET /api/llm/providers` says which harnesses are installed, `GET /api/llm/models?provider=` lists each harness's models with the levels and speeds it offers (`server/llmProviders.ts`, read from the harness itself), free text is accepted too. **Scan harnesses** (`POST /api/llm/scan`) does both at once for every harness, skipping the 10-minute model cache; a harness that can't list its models is reported, not fatal.

| harness | warm agent (`adapters/harnesses.ts`) | level | Fast |
|---|---|---|---|
| Claude Code | `claude -p` started with its prompt, waiting on stdin | `--effort` low…max | `--settings {"fastMode":true}`, Opus 5.5 only; needs usage credits on the account (else served standard: the prompt view flags it) |
| Codex | a thread pre-created on one shared `codex app-server` (JSON-RPC); the request is a turn | `effort` per model (model cache) | `serviceTier: "priority"` where the model lists it |
| opencode | a session pre-created on one shared `opencode serve`; the request is a message (HTTP + SSE) | the model's variants | – |
| Pi / OhMyPi | `pi\|omp --mode rpc` started with its prompt, waiting for a `prompt` command | `--thinking` | omp `--service-tier priority`: OpenAI priority, or Opus fast mode on Anthropic (not via OpenRouter) |
| Grok | none: `grok -p` reads its prompt before booting, and its ACP mode ignores our prompt and tool limits, so each request is cold | `--reasoning-effort` per model | – |

- *Warm pools* (`adapters/warmPool.ts`): one pool per role and choice (router and progress lines on the fast tier, the solver on the smart one); taking an agent starts its replacement. `configureWarm(selection)` kills every other pool (and the shared Codex / opencode server once nothing uses it) and starts the chosen ones. The selection is saved (`server/llmSelection.ts`, `~/.config/realtime-voice/llm-selection.json`, `POST /api/llm/selection` from the Chat page) and warmed at server start, so only the first switch to a new choice pays the harness's start-up. `WARM_AGENTS=0` turns warming off.
- *Yolo*: every harness runs without approval prompts (Claude Code `--dangerously-skip-permissions`, Codex `approvalPolicy: never` + `danger-full-access`, Grok `--always-approve`, opencode permissions all `allow` and its `question` tool off, omp `--approval-mode=yolo`; Pi has no prompts). The router and progress lines get no tools and an empty folder; the solver gets the project folder with file tools (Claude Code also denies `.env*`). Nothing confines file writes to the folder except the prompt.
- *Output*: the router and progress lines write their JSON as text (streamed into the same parser); the solver answers SPOKEN:-first. Harnesses other than Claude Code narrate before their tools; that text is dropped up to the `SPOKEN:` line (`NarrationGate`).
- *Prices*: Claude Code calls are priced from the Claude table and count as saved (subscription); Codex and Grok (grok.com login) too, from the models.dev catalog (`server/prices.ts`); opencode, Pi and OhMyPi report their own per-call cost (billed to their keys; OhMyPi on the ChatGPT login counts as subscription). Without a price the cost line says "price unknown". `npm run bench:harness` measures warm vs cold for a selection.

## 5. Timing model

**Clock.** The browser's `performance.now()` is the reference clock. On connect, the client sends 10 `ping`s and keeps the one with the lowest round-trip time: `offset = serverNow − (clientNow + rtt/2)`. The client converts server marks to client time with `t = serverNow − offset`. Re-sync every 60 s. Record the RTT and offset in each `RunRecord`.

**Marks** (`shared/marks.ts`). Each is stamped where it happens: `C` = client, `S` = server.

| Mark | Where | Meaning |
|---|---|---|
| `press` | C | key down / replay start |
| `release` | C | key up / replay end. **t = 0 for every latency metric** |
| `stt.firstPartial` | S | first Scribe partial |
| `stt.final` | S | Scribe committed transcript with words received |
| `pointing.resolved` | S | resolver finished |
| `llm.request` | S | request sent to the router |
| `llm.firstToken` | S | first text or audio delta from the voice LLM |
| `llm.toolCall` | S | `ask_solver` call detected (name known; args may still be streaming) |
| `ack.ttsFirstByte` | S | first audio byte of the acknowledgment from TTS |
| `ack.played` | C | first ack sample actually played (player worklet) |
| `solver.request` | S | Solver request sent |
| `solver.firstToken` | S | first solver text delta |
| `solver.spokenReady` | S | `SPOKEN:` line complete |
| `solver.done` | S | Solver stream finished |
| `answer.ttsFirstByte` | S | first audio byte of the answer |
| `answer.played` | C | first answer sample played |
| `turn.end` | S | all audio sent, turn closed |

**Derived metrics** (computed client-side and stored in `RunRecord.metrics`, in ms relative to `release`): `ttfa = min(ack.played, answer.played)`, `tta = answer.played`, `stt = stt.final`, `llmFirst = llm.firstToken`, `toolCall = llm.toolCall`, `solverFirst = solver.firstToken`, `solverSpoken = solver.spokenReady`, `solverTotal = solver.done − solver.request`, `ttsFirst = answer.ttsFirstByte − (solver.spokenReady | llm.firstToken)`.

**"Played" means played.** The player worklet reports the `AudioContext` time of the first non-silent sample it renders. Convert it to `performance.now()` with `ctx.getOutputTimestamp()`, which also accounts for output latency.

`RunRecord` = `{ runId, turnId, approach, config, fixtureId?, marks: Record<MarkName, number>, metrics, transcript, pointing, voiceText, solverText, usage: {anthropic?, openai?, elevenChars?, scribeSeconds?}, costUsd, clock: {rttMs, offsetMs}, error? }`.

Usage shapes written by the orchestrators (T7): `anthropic: {router?, solver?, fillers?}` = the raw Anthropic `usage` objects (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `speed`); `elevenChars` = characters sent to TTS; `scribeSeconds` = audio seconds sent to Scribe. `server/cost.ts` documents the price assumptions where API-NOTES lists none (cache writes 1.25× input, Haiku cache reads 0.1×, fast-mode cache reads 2×).

## 6. Pointing resolution

Implement it in `shared/pointing.ts`, as pure functions so they can be unit tested on saved fixtures.

```ts
const POINTING_WORDS = /^(this|that|these|those|here|there)$/i;  // strip punctuation first
type Resolver = (word: Word, tAudioStart: number, samples: CursorSample[]) => CursorSample | null;
```

`tAudioStart` is the client time of the **first audio sample captured** for the turn, not the key-press time. Word absolute time = `tAudioStart + word.start * 1000`.

Algorithms (all of them run, and each is shown in its own color):

| Name | Rule |
|---|---|
| `atStart` | sample closest to the word's start time |
| `dwell` | in the window [start − 300 ms, end + 200 ms], the sample with the lowest speed relative to its previous sample (the pointing pause) |
| `mode` | the element appearing in the most samples inside that window |
| `dwellMode` | `dwell`, but break ties toward the `mode` element |

Window offsets are config values (`preMs`, `postMs`).

**Precise rules (as implemented in `shared/pointing.ts`, T9):**
- A word is a pointing word if, lowercased with every non-letter stripped (`"This,"` → `"this"`), it matches `POINTING_WORDS`.
- Window = `[tAudioStart + start·1000 − preMs, tAudioStart + end·1000 + postMs]`, inclusive. Defaults `preMs = 300`, `postMs = 200` (`DEFAULT_WINDOW`, same as `DEFAULT_CONFIG`).
- **Speed** of a sample = viewport pointer distance `hypot(Δx, Δy)` to the previous sample in the *whole* trail ÷ Δt (px/ms). Scrolling is not hand motion and doesn't count. The first sample of the trail (or Δt ≤ 0) has no speed and is never a `dwell` candidate.
- `atStart`: closest sample to the word start over the whole trail (no window); null only if there are no samples.
- `dwell`: lowest speed in the window; exact ties → closest to the word start. If no in-window sample has a speed, the closest in-window sample. Null if the window is empty.
- `mode`: most frequent non-null `elementPath` in the window (ties → the element seen closest to the word start); returns that element's sample closest to the word start.
- `dwellMode`: candidates are window samples with speed ≤ `minSpeed + DWELL_TIE_EPS` (**0.05 px/ms = 50 px/s**, i.e. "also basically still"). Prefer candidates on the `mode` element, then closest to the word start.
- `resolvePointing` returns one `PointingTarget` per (pointing word × algorithm), in word order then `atStart, dwell, mode, dwellMode`. `word` is the normalized word, `wordStart` is `word.start` (**seconds** from turn audio start).

**Languages (English + Romanian).** `RunConfig.language` = auto | en | ro. Scribe omits `language_code` unless pinned; its realtime API returns `language_code: null` when auto-detecting, so the turn's language is pinned → Scribe's code → `detectLanguage(text)` (Romanian diacritics + common words) and is sent on `stt.final`. Pointing words come from `POINTING_LEXICON` (en + ro, diacritic-insensitive, hyphenated clitics; auto = both). Every model is told the reply language.

**Cursor rests (any language).** `computeRests` finds where the cursor stayed on one element ≥ 250 ms while the user spoke (dropped where a pointing word already covers it), numbered `@1, @2…`. They're marked in the transcript (`it [@1]`, except a cursor parked the whole time) and sent as `Cursor rested [@1] on …` lines — weaker hints the models use for "it", "the blue button", or words outside the lexicon.

**Reference numbers.** `resolvePointing` gives each pointing word a `ref` (1, 2, … in speech order, shared by all algorithms) and its `wordIndex`. Every LLM sees `Transcript: "move this [1] over there [2]"` (`annotateTranscript`) and numbered lines `Pointing [1] "this" at 0.3 s → …` (`formatPointingLine`); click/highlight lines name the word as `"this" [1]`.

**Server-side resolution:** in the pipeline (and `cursor-only`), the server runs the resolver as soon as `stt.final` arrives, using the cursor samples streamed during the turn and `config.preMs/postMs`. `formatPointingContext(targets, "dwellMode")` formats it for the LLM context, one line per pointing word (tag = last `elementPath` segment; `in "…"` = the container, omitted when null or equal to the label; missing parts are omitted; no pick → `(nothing)`):
`Pointing: "this" → <button> "Get started" in "Hero section" [data-source=demo.html:27]`
`Pointing: "this" → <h3> "Live queries" in "Card: Live queries" [data-source=demo.html:36]`.

`formatPageContext(clicks, selection, words, tAudioStart)` adds the turn's clicks and highlighted text: one `Clicked:` line per click (sorted, consecutive clicks on the same element deduped, the latest 5), naming the word whose span `[tAudioStart + start·1000, tAudioStart + end·1000]` is nearest the click (omitted without words/tAudioStart or when no word is within 1 s), then one `Selected text:` line (text collapsed and cut to 200 chars; the element's label is left out when it only repeats the text):
`Clicked: <th> "Price / month" in "Pricing table" [data-source=demo.html:67] (while saying "that")`
`Selected text: "Charts refresh as rows land." in <p> in "Card: Live queries" [data-source=demo.html:37]`.

**Demo page markup.** Components (cards, the pricing table, the form, sections) carry `data-label`, and so do the specific elements inside them that have their own `data-source` (card titles and texts, table headings, form labels/inputs, nav links, the CTA). Table body cells have no data-source of their own: a `<td>` reports its row's line, with the row ("Row: Team") as container.

The cursor lab (which showed the picks live, saved sessions as `fixtures/utterances/Uxx.{wav,cursor.json,labels.json}` and scored resolver accuracy against labels) was removed along with its fixture endpoints; the resolver rules above are covered by `shared/pointing.test.ts`.

## 7. Orchestrator sketches

Approaches A (`realtime`, OpenAI Realtime speech-to-speech) and C (`hybrid`, Realtime + Scribe for pointing) were removed on 2026-10-17; only the pipeline is developed (git history has them).

**Pipeline (`pipeline.ts`).** `turn.start` → `openScribe` (pre-warmed) + open TTS → stream audio to Scribe → `release` → `commit()` → `final()` → resolve pointing → `routeTurn` (its spoken deltas go to TTS as the `ack` segment) → if delegated: `solveTask`, sending `onSpokenLine` to a fresh TTS flush as the `answer` segment.

**cursor-only (`cursorOnly.ts`).** For dictating into a comment (the sidebar inserts the final words at the caret; no reply, not remembered): `turn.start` → `openScribe` → stream audio → `release` → `commit()` → `final()` → `stt.final` → `resolvePointing` → mark `pointing.resolved`, send `pointing.resolved` → mark `turn.end`. No LLM, no TTS. Usage records `scribeSeconds`.

**Pre-warming.** Open the vendor sockets on `turn.start` (or keep them alive per connection) so connection setup isn't counted in latency. Record cold-vs-warm as a config flag.

### As built (T7)

- **Segments.** `audio.segment start` goes out right before a segment's first audio byte and `end` after its last; segments are serialized (later audio is held until the earlier segment ends); a segment that never gets audio sends nothing, so the Session never waits for an `audio.played` that can't come.
- **Labelling.** Forced mode: the router's speech is the `ack`. Auto mode: the first delta's `kind` decides (`ack` if it called `ask_solver`, `answer` if it answered directly). The pre-warmed first TTS socket is opened as "ack"; its `*.ttsFirstByte` mark is renamed to the final label. The ack socket is flushed on `onSpokenEnd` (or when the router returns). The answer socket opens when the solver is requested (warm) or when the spoken line is ready (cold). Rare auto-mode "text, then tool call" turns are flagged `turn.end.meta.labelConflict`.
- **Cold (`prewarm: false`).** Sockets open on release (Scribe) or when first needed (TTS), so setup is inside the measured latency; `llm.request.meta.cold = true` (also on `turn.end`).
- **Errors / cancel.** Any adapter failure → `error {source: scribe|tts|router|solver|timeout}` and `done` resolves with `error` set. Overall turn timeout 60 s from `turn.start`. `cancel()` closes every socket opened for the turn.
- **Headless check.** `npm run smoke:e2e` (real keys; SKIPs without them) and `npm run smoke:e2e -- --fake` (fake adapters over the real `/ws`) print a RunRecord with marks relative to release.

**Chat mode (`RunConfig.memory`, the `/chat.html` page).** The Session appends each finished turn (`{user, assistant, detail}`) to a per-connection conversation log (`server/conversation.ts`); `conversation.reset` clears it. The pipeline sends the log to the router and the solver as prior messages. Benchmark runs keep `memory: false`.

**Chat behaviours (RunConfig `fillers`, `backgroundLongTasks`, `longTaskSeconds`; set by `/chat.html`).**
- *Decision.* The router's forced `route` tool outputs `intent` (question | task | clarify | answer) and `estimate_seconds` before `say`; `onDecision` fires as soon as they parse. The orchestrator sends `decision {intent, estimateS, background}`. Clarify = the voice layer asks one follow-up question instead of guessing; the conversation memory carries the answer into the next turn.
- *Short tasks (estimate ≤ longTaskSeconds): fillers.* `generateFillers` (fast tier, in parallel with the solver) returns ≤ 3 progress lines. `orchestrators/fillers.ts` speaks the next line once everything said so far has played (`SegmentOutput.playEnd`, estimated from bytes sent) plus a 900 ms pause, until the solver's spoken line is ready. One TTS socket per line (segment `filler`). The answer segment queues after any filler in progress.
- *Long tasks: background jobs* (`orchestrators/jobs.ts`). The ack says it'll get back to the user; the turn ends; the solver runs on. On completion: `job {state: done, spoken, detail}`, the result joins the conversation log, and a notice is spoken once no turn is active (`ConnectionChannel.whenIdle`) with the turn's TTS engine, framed by `notice {jobId, start|end}`. A turn that starts first preempts it (retried later); a turn started during it stops it.
- *Interrupting.* The client stops playback and sends `turn.cancel {reason: "interrupt" | "stop"}` (and `speech.stop` for notices). The Session records what was said so far in the conversation ("… [interrupted by the user]").
- *Debug view (prompts & responses).* Each model call gets a `callId` (`orchestrators/trace.ts`): `llm.prompt` carries the exact request (system blocks labelled and marked cached, messages, tools, settings) and `llm.response` the raw result (final message, stop reason, usage, duration, or the error). The Chat page pairs them per turn and per background job.
- *On-device TTS (`ttsModel: "macos"`).* `tools/mactts/main.swift` (AVSpeechSynthesizer) runs as a persistent helper — compiled once into `node_modules/.cache/mactts/` (keyed by source hash) and started by `npm run dev` (`MAC_TTS=0` skips) — streaming PCM16 24 kHz framed on stdout. `server/adapters/macTts.ts` puts it behind the TtsStream interface: text goes a sentence at a time (rest on flush); the voice follows the turn's language (best en-US voice installed / Ioana), resolved per sentence because pre-opened streams learn the language later. Not billed: counted as `localTtsChars`, shown as saved vs ElevenLabs. Benchmarks: `docs/BENCH-tts.md`.
- *Costs.* Each `llm.response` carries `costUsd` (its usage × the API-NOTES prices; `server/cost.ts callCost`). `RunRecord.costItems` itemizes a turn (each model-call kind, ElevenLabs characters per segment, Scribe seconds; sums to `costUsd`). Background jobs report `costUsd`/`costItems` (their solver call, then + speaking the result); the Chat page adds them to the turn that started the job. Calls through a CLI's own login (Claude Code, Codex, Grok on grok.com) run on a subscription: they count $0 toward totals (`RunRecord.costUsd`, job `costUsd`) and carry `savedUsd` (their API-price cost), shown as "$… saved".
- *Page context.* During a turn the client records clicks and the highlighted text and sends `turn.context` before `turn.release`; `formatPageContext` turns them into `Clicked: …` / `Selected text: …` lines (they need no word timestamps).

## 8. Decisions and alternatives

- **One server WebSocket for everything.** One network path, keys stay server-side, and every mark is instrumented in one place.
- **Push-to-talk first.** It removes end-of-speech detection delay. Always listen (a level VAD in the sidebar) is an option.
- **Replayed WAVs are the source of truth** for benchmark numbers (`npm run smoke:e2e`, `bench:*`). Live use is for feel.
- **Scribe `commit_strategy=manual`.** The release is the commit.
