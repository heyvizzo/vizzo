# Architecture

Read `PRD.md` first. This doc defines the **contracts** that parallel workers build against. If you need to change a contract, update this file in the same change.

## 1. Stack and layout

- **Language:** TypeScript everywhere. Node ≥ 22 (dev machine has v26), npm.
- **Web:** Vite + vanilla TS, no framework. Two pages: `/` (latency lab) and `/cursor` (cursor lab).
- **Server:** Node + `ws`, run with `tsx`. `dotenv` loads `.env`.
- **Vendor SDKs:** `@anthropic-ai/sdk` for Claude. OpenAI Realtime and ElevenLabs use raw WebSockets (`ws`), with no extra SDKs.
- **Dev:** `npm run dev` runs the server (port 8787) and Vite (port 5173) together. Vite proxies `/ws` and `/api` to the server.

```
realtime-voice/
├─ docs/                      # this folder
├─ shared/
│  ├─ protocol.ts             # browser↔server message types (§3)
│  ├─ marks.ts                # timing mark names (§5)
│  └─ config.ts               # RunConfig type + defaults
├─ server/
│  ├─ index.ts                # http + ws entry, session routing
│  ├─ session.ts              # one browser connection = one Session
│  ├─ clock.ts                # server-side mark stamping
│  ├─ adapters/
│  │  ├─ scribe.ts            # ElevenLabs Scribe v2 Realtime (STT)
│  │  ├─ openaiRealtime.ts    # OpenAI Realtime WS
│  │  ├─ elevenTts.ts         # ElevenLabs TTS streaming
│  │  └─ claude.ts            # Haiku router + Opus solver
│  ├─ orchestrators/
│  │  ├─ realtime.ts          # approach A
│  │  ├─ pipeline.ts          # approach B
│  │  └─ hybrid.ts            # approach C
│  ├─ prompts/                # system prompts as .md files
│  ├─ fixtures-context/       # the "codebase" Opus answers questions about
│  └─ results.ts              # append runs to results/*.jsonl
├─ web/
│  ├─ index.html, cursor.html
│  ├─ audio/
│  │  ├─ capture-worklet.ts   # mic → PCM16 frames
│  │  ├─ player-worklet.ts    # PCM16 24k playback, reports first-sample-played
│  │  └─ replay.ts            # WAV fixture → frames at real-time pace
│  ├─ ws.ts                   # typed client for shared/protocol.ts
│  ├─ lab/                    # latency lab UI: controls, waterfall, results table
│  └─ cursor/                 # sampler, resolvers, timeline viz, labeling
├─ scripts/smoke-*.ts         # one standalone smoke test per adapter
├─ fixtures/utterances/       # Uxx.wav + Uxx.cursor.json + Uxx.labels.json (shapes in §6.1)
├─ results/                   # *.jsonl (gitignored)
├─ .env.example               # ANTHROPIC_API_KEY, OPENAI_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID
└─ package.json
```

## 2. Data flow

```
Browser                                   Server                                Vendors
───────                                   ──────                                ───────
mic/replay → capture-worklet ─PCM16 24k──▶ Session ──▶ orchestrator(A|B|C)
pointer sampler ─cursor samples──────────▶   │           ├─ scribe.ts ─────────▶ ElevenLabs STT WS
                                             │           ├─ openaiRealtime.ts ─▶ OpenAI Realtime WS
player-worklet ◀────────PCM16 24k──────────  │           ├─ claude.ts ─────────▶ Anthropic Messages (stream)
waterfall UI ◀──────────marks/events───────  │           └─ elevenTts.ts ──────▶ ElevenLabs TTS WS
```

- **Audio up:** the browser always sends **PCM16 mono 24 kHz little-endian** as binary WS frames. OpenAI Realtime takes 24k PCM natively. Scribe accepts `audio_format=pcm_24000`, so we skip resampling.
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
  | { type: "opus.text"; turnId: string; delta: string }         // full Opus answer, streamed
  | { type: "audio.segment"; turnId: string; segment: "ack" | "answer"; state: "start" | "end" }
  // binary frame: PCM16 24k audio for the active turn's current segment
  | { type: "turn.done"; turnId: string; run: RunRecord }
  | { type: "error"; turnId?: string; source: string; message: string };

interface Word { text: string; start: number; end: number }           // seconds from turn audio start
interface CursorSample {
  t: number; x: number; y: number; scrollX: number; scrollY: number;
  elementPath: string | null;   // stable CSS path of document.elementFromPoint at sample time
  dataSource: string | null;    // closest [data-source] attribute, "file:line"
  label: string | null;         // closest [data-label] or accessible name
}
interface PointingTarget { word: string; wordStart: number; algorithm: string; sample: CursorSample | null }
```

The canonical types live in `shared/protocol.ts`. **Server-side bookkeeping:** the server converts every server mark to client time using the `clock.sync` offset and stores it in `RunRecord.marks`. After the orchestrator finishes, it waits (up to 3 s) for an `audio.played` for every segment it sent, then sends `turn.done` and appends the run to `results/`.

Only one turn is active at a time. Binary frames always belong to the active turn. Audio sent after `turn.release` is ignored.

### Browser audio API (`web/audio/*`)

Built by T2, used by the cursor lab (T9) and the latency lab (T8). Signatures are fixed in the stub files: `startCapture({onFrame}) → {tAudioStart, stop}` (`capture.ts`), `createPlayer() → Player` with `startSegment/push/endSegment/onPlayed/reset` (`player.ts`), `startReplay({wav, cursor, onFrame, onCursor}) → {tAudioStart, done, stop}` (`replay.ts`), `bindPushToTalk({button, onPress, onRelease})` (`ptt.ts`), `createWavRecorder()` (`record.ts`). Frames are 20 ms PCM16 24 kHz `Int16Array`s.

Implementation notes (T2, no signature changes): one shared `AudioContext` at the native rate plus one mic stream (`context.ts`, which also exports `warmUpAudio()`; call it from a user gesture before the first turn so the permission prompt and context start aren't counted in a turn). Pure helpers live in `dsp.ts` (windowed-sinc resampler, framing, PCM conversion), `wav.ts` (parse/encode) and `timing.ts` (context time ↔ `performance.now()`). `tAudioStart` is the estimated capture time of the first sample delivered after `startCapture`, so it can be a few ms *before* the key press (the mic pipeline buffers audio). Replay's `tAudioStart` is the replay start time, and frame k is sent at `tAudioStart + (k+1)·20 ms`, like a live mic. `onPlayed` fires for the first sample above about −60 dBFS in each `startSegment()`. Audio pushed before any `startSegment()` plays but is never reported.

## 4. Server adapter interfaces

The interfaces are in `server/adapters/types.ts` (with the shared `ASK_OPUS_TOOL`). Additions over the sketch below: `openTts` takes `segment: "ack" | "answer"` (which `*.ttsFirstByte` mark to emit) and `TtsStream` exposes `chars`; `SttStream` exposes `seconds` (audio seconds sent, feeds `usage.scribeSeconds`); `RealtimeSession` exposes `usage` (typed `RealtimeUsage`) plus T4's `beginTurn`, `setMark`, `onError`, `currentSegment`; `routeWithHaiku` also returns `usage`. Orchestrators implement `Orchestrator = (ctx: TurnContext) => TurnHandlers` from `server/orchestrators/types.ts`, and `server/session.ts` routes to them by `config.approach`. `server/cost.ts` computes `costUsd`.

**T7 additions (additive):**
- `routeWithHaiku`'s `onSpokenDelta(d, kind)` gets `kind: "ack" | "answer"` ("ack" = the `ack` field of an `ask_opus` call, "answer" = a direct text answer in auto mode), and an optional `onSpokenEnd("ack")` fires as soon as the ack field is complete (before `question` is written), so the pipeline flushes the ack TTS early.
- `TurnContext.connection: ConnectionCache` (`get/set(key, value, dispose?)/delete`): per-browser-connection state, disposed when the WebSocket closes. Used for the reusable Realtime session.
- `TurnResult.ackIsAnswer?: boolean`: see §7 A. The Session then renames `ack.ttsFirstByte`/`ack.played` to `answer.*` in the RunRecord (`markMeta[...].relabeledFrom`).
- Each orchestrator module exports a factory `createXOrchestrator(deps: OrchestratorDeps)` (deps = the five adapter functions + `voiceId?`, `turnTimeoutMs?`, `hybridLateWaitMs?`); the default export uses the real adapters (`server/orchestrators/deps.ts`). Fakes with the same marks live in `server/orchestrators/fakes.ts` (tests, `smoke:e2e --fake`).
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

interface RealtimeSession {                    // server/adapters/openaiRealtime.ts — ONE session reused across turns (§7)
  beginTurn(): void;                           // T4: sends input_audio_buffer.clear, resets per-turn mark state
  setMark(mark: Mark): void;                   // T4: swap the per-turn mark function on the reused session
  onError(cb: (err: Error) => void): void;     // T4: vendor `error` events + socket failures
  readonly currentSegment: "ack" | "answer";   // T4: "answer" for the response created after sendToolResult
  readonly usage: RealtimeUsage;               // T4: {responses: raw usage[], totals: {inputText, inputAudio, cachedText, cachedAudio, outputText, outputAudio, ...}}
  pushAudio(pcm24k: Buffer): void;
  commitAndRespond(extraContext?: string): void; // commit buffer, optionally add a context item, then response.create
  onAudio(cb: (pcm24k: Buffer) => void): void;
  onText(cb: (delta: string) => void): void;
  onToolCall(cb: (call: { callId: string; name: string; args: unknown }) => void): void;
  sendToolResult(callId: string, output: string): void;  // then response.create (deferred until the active response is done)
  responseDone(): Promise<void>;               // current/next response.done; resolves at once if none outstanding; rejects on failed response.create / close
  close(): void;
}
function openRealtime(opts: { mark: Mark; model: "gpt-realtime-2.1" | "gpt-realtime-2.1-mini"; instructions: string; tools: ToolDef[]; voice?: string }): Promise<RealtimeSession>;
// T4: resolves after session.updated (session.created → session.update → session.updated), so PTT config is live
// before any audio. Marks: llm.request (commitAndRespond), llm.firstToken (first audio/transcript delta of the turn),
// llm.toolCall {name} (output_item.added function_call), ack.ttsFirstByte / answer.ttsFirstByte (first audio per segment).
// Context items are role "user" input_text. Tests inject the socket via createOpenRealtime({ WebSocket }).

// server/adapters/claude.ts
function routeWithHaiku(opts: {
  mark: Mark; transcript: string; pointing: PointingTarget[]; mode: "forced" | "auto";
  onSpokenDelta: (d: string) => void;          // text to speak right away (ack, or a direct answer in auto mode)
}): Promise<{ delegate: null | { question: string } }>;

function solveWithOpus(opts: {
  mark: Mark; question: string; pointing: PointingTarget[]; fast: boolean;
  onSpokenLine: (line: string) => void;        // fires once the SPOKEN: line is complete
  onDelta: (d: string) => void;                // full answer stream
}): Promise<{ text: string; usage: unknown }>;
```

### Claude settings (read `API-NOTES.md` §Claude before writing claude.ts)
- **Provider:** OpenRouter's Anthropic-compatible endpoint when `OPENROUTER_API_KEY` is set (model IDs `anthropic/claude-*-5.5`, no `fallbacks`, fast mode not honored). See API-NOTES "Live checks".
- **Haiku router:** `model: "claude-haiku-5-5"`, `output_config: {effort: "low"}`, streaming. Don't send `temperature`/`top_p`/`top_k` (non-default values are a 400). Forced mode: `tool_choice: {type: "tool", name: "ask_opus"}` (Haiku 5.5 accepts it and skips thinking). Put the spoken acknowledgment **inside the tool input** (`ack` field) so it can stream out before the call finishes; use `eager_input_streaming: true` on the tool and validate the parsed input.
- **Opus solver:** `model: "claude-opus-5-5"`, streaming, `output_config: {effort: "medium"}` (set it explicitly). Thinking can't be disabled, so don't send `thinking: disabled`. No forced `tool_choice`. Fast mode: `client.beta.messages.stream({... speed: "fast", betas: ["fast-mode-2026-02-01"]})`. Add refusal fallbacks (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) and check `stop_reason` before reading content.
- Cache the system prompt and the fixture codebase context with `cache_control` so repeated benchmark runs hit the cache, and log `usage.cache_read_input_tokens`.

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
| `llm.request` | S | request sent to Haiku / `response.create` sent to Realtime |
| `llm.firstToken` | S | first text or audio delta from the voice LLM |
| `llm.toolCall` | S | `ask_opus` call detected (name known; args may still be streaming) |
| `ack.ttsFirstByte` | S | first audio byte of the acknowledgment from TTS or Realtime |
| `ack.played` | C | first ack sample actually played (player worklet) |
| `opus.request` | S | Opus request sent |
| `opus.firstToken` | S | first Opus text delta |
| `opus.spokenReady` | S | `SPOKEN:` line complete |
| `opus.done` | S | Opus stream finished |
| `answer.ttsFirstByte` | S | first audio byte of the answer |
| `answer.played` | C | first answer sample played |
| `turn.end` | S | all audio sent, turn closed |

**Derived metrics** (computed client-side and stored in `RunRecord.metrics`, in ms relative to `release`): `ttfa = min(ack.played, answer.played)`, `tta = answer.played`, `stt = stt.final`, `llmFirst = llm.firstToken`, `toolCall = llm.toolCall`, `opusFirst = opus.firstToken`, `opusSpoken = opus.spokenReady`, `opusTotal = opus.done − opus.request`, `ttsFirst = answer.ttsFirstByte − (opus.spokenReady | llm.firstToken)`.

**"Played" means played.** The player worklet reports the `AudioContext` time of the first non-silent sample it renders. Convert it to `performance.now()` with `ctx.getOutputTimestamp()`, which also accounts for output latency.

`RunRecord` = `{ runId, turnId, approach, config, fixtureId?, marks: Record<MarkName, number>, metrics, transcript, pointing, voiceText, opusText, usage: {anthropic?, openai?, elevenChars?, scribeSeconds?}, costUsd, clock: {rttMs, offsetMs}, error? }`.

Usage shapes written by the orchestrators (T7): `anthropic: {haiku?, opus?}` = the raw Anthropic `usage` objects (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `speed`); `openai` = `RealtimeUsage` for **this turn only** (diffed against the reused session's cumulative counters); `elevenChars` = characters sent to TTS; `scribeSeconds` = audio seconds sent to Scribe. `server/cost.ts` documents the price assumptions where API-NOTES lists none (cache writes 1.25× input, Haiku cache reads 0.1×, fast-mode cache reads 2×, one cached rate for Realtime text and audio).

## 6. Pointing resolution (shared between both labs)

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

Window offsets are config values (`preMs`, `postMs`). The cursor lab has sliders to tune them against labeled sessions.

**Precise rules (as implemented in `shared/pointing.ts`, T9):**
- A word is a pointing word if, lowercased with every non-letter stripped (`"This,"` → `"this"`), it matches `POINTING_WORDS`.
- Window = `[tAudioStart + start·1000 − preMs, tAudioStart + end·1000 + postMs]`, inclusive. Defaults `preMs = 300`, `postMs = 200` (`DEFAULT_WINDOW`, same as `DEFAULT_CONFIG`).
- **Speed** of a sample = viewport pointer distance `hypot(Δx, Δy)` to the previous sample in the *whole* trail ÷ Δt (px/ms). Scrolling is not hand motion and doesn't count. The first sample of the trail (or Δt ≤ 0) has no speed and is never a `dwell` candidate.
- `atStart`: closest sample to the word start over the whole trail (no window); null only if there are no samples.
- `dwell`: lowest speed in the window; exact ties → closest to the word start. If no in-window sample has a speed, the closest in-window sample. Null if the window is empty.
- `mode`: most frequent non-null `elementPath` in the window (ties → the element seen closest to the word start); returns that element's sample closest to the word start.
- `dwellMode`: candidates are window samples with speed ≤ `minSpeed + DWELL_TIE_EPS` (**0.05 px/ms = 50 px/s**, i.e. "also basically still"). Prefer candidates on the `mode` element, then closest to the word start.
- `resolvePointing` returns one `PointingTarget` per (pointing word × algorithm), in word order then `atStart, dwell, mode, dwellMode`. `word` is the normalized word, `wordStart` is `word.start` (**seconds** from turn audio start).

**Server-side resolution:** in approaches B and C (and `cursor-only`), the server runs the resolver as soon as `stt.final` arrives, using the cursor samples streamed during the turn and `config.preMs/postMs`. `formatPointingContext(targets, "dwellMode")` formats it for the LLM context, one line per pointing word (tag = last `elementPath` segment; missing parts are omitted; no pick → `(nothing)`):
`Pointing: "this" → <button> "Get started" [data-source=web/cursor/demo/demo.html:27]`.

**Cursor lab specifics.** The demo page (`web/cursor/demo/demo.html`) is injected into the lab's own document (no iframe) inside a scroll container `#demo-scroller > #demo-root`; its CSS is wrapped in `@scope (#demo-root)`. In the cursor lab, `CursorSample.scrollX/scrollY` are that container's `scrollLeft/scrollTop` (not `window.scrollX/Y`), and `elementPath`/`dataSource`/`label` are null when the pointer is outside the demo. `elementPath` is a `querySelector`-valid path: `tag#id` for the nearest CSS-safe id, else `tag:nth-of-type(n)` segments (e.g. `div#demo-root > main > article:nth-of-type(2) > h3`).

### 6.1 Fixture files (`fixtures/utterances/`)

The cursor lab saves (and loads, by file name) three files per session; `Uxx` is the session id.

- `Uxx.wav`: 16-bit mono 24 kHz PCM WAV of the turn's captured audio (`createWavRecorder`). Sample 0 is `tAudioStart`.
- `Uxx.cursor.json`:
  ```ts
  { version: 1; kind: "cursor"; id: "U04"; createdAt: string /* ISO */; transcript: string;
    words: Word[];               // as received in stt.final (seconds from tAudioStart)
    samples: CursorSample[];     // t = ms RELATIVE to tAudioStart (negative = before audio start); 500 ms pre-roll before press, 300 ms after release
    viewport?: { width: number; height: number } }  // demo scroller size at record time
  ```
  `samples` is exactly what `startReplay({cursor})` takes. Resolvers run on it with `tAudioStart = 0`.
- `Uxx.labels.json`:
  ```ts
  { version: 1; kind: "labels"; id: "U04";
    labels: { wordIndex: number /* into words[] */; word: string /* normalized */; start: number; end: number /* s */;
              target: { elementPath: string | null; dataSource: string | null; label: string | null } | null /* null = unlabeled */ }[] }
  ```
  One entry per pointing word. (HTTP, T8: `GET /api/fixtures` lists the file names in `fixtures/utterances/` and `GET /api/fixtures/<name>` serves one; only `^[A-Za-z0-9_-]+\.(wav|cursor\.json|labels\.json)$` names are accepted. `GET /api/results` returns every `RunRecord` in `results/*.jsonl`.) A pick is **correct** if `pick.dataSource === target.dataSource` (when the target has one; targets are the `[data-source]` elements, so a pick on a child of the card counts), otherwise if the `elementPath`s are equal. Accuracy = correct / labeled words, per algorithm.

## 7. Orchestrator sketches

**A (`realtime.ts`).** `turn.start` → `openRealtime` (pre-warm one session per connection and reuse it) → stream audio → `release` → `commitAndRespond()` → stream audio and text to the client. On `ask_opus`: ack audio is already flowing from the model → `solveWithOpus` → `sendToolResult(callId, spokenLine + "\n\n" + summary)` → the model speaks the answer segment. Pointing isn't available (no word timestamps), and that's the point of A.

**B (`pipeline.ts`).** `turn.start` → `openScribe` (pre-warmed) + open TTS → stream audio to Scribe → `release` → `commit()` → `final()` → resolve pointing → `routeWithHaiku` (its spoken deltas go to TTS as the `ack` segment) → if delegated: `solveWithOpus`, sending `onSpokenLine` to a fresh TTS flush as the `answer` segment.

**C (`hybrid.ts`).** Same as A, except audio is **also** sent to Scribe. On `release`: commit both, wait for Scribe `final()` for up to `hybridWaitMs`, resolve pointing, then `commitAndRespond(pointingContext)`. If Scribe times out, respond without the context and record `meta.pointingMissed = true`.

**cursor-only (`cursorOnly.ts`, T9).** For the cursor lab: `turn.start` → `openScribe` → stream audio → `release` → `commit()` → `final()` → `stt.final` → `resolvePointing` → mark `pointing.resolved`, send `pointing.resolved` → mark `turn.end`. No LLM, no TTS. Usage records `scribeSeconds`.

**Pre-warming.** Open the vendor sockets on `turn.start` (or keep them alive per connection) so connection setup isn't counted in latency. Record cold-vs-warm as a config flag.

### As built (T7)

- **Segments.** `audio.segment start` goes out right before a segment's first audio byte and `end` after its last; segments are serialized (later audio is held until the earlier segment ends); a segment that never gets audio sends nothing, so the Session never waits for an `audio.played` that can't come.
- **A/C labelling.** The first Realtime response of a turn is `"ack"` on the wire, the post-tool response `"answer"` (the adapter's `currentSegment`). Whether a tool call follows is only known after audio has started, so if the turn ends **without** `ask_opus`, the orchestrator returns `ackIsAnswer: true` and the RunRecord's ack marks become answer marks (PRD §7: TTA = TTFA for easy questions). The live UI sees the wire label; the stored RunRecord is canonical.
- **A/C tool result.** `sendToolResult(callId, spokenLine + "\n\n" + note)` the moment `onSpokenLine` fires (the note says the detailed answer is on screen); `opus.text` keeps streaming until Opus is done. Prompt: `server/prompts/realtime.md`.
- **Realtime session reuse.** One session per connection in `ctx.connection` (shared by A and C), opened on the first warm turn's `turn.start`, reused with `beginTurn()` + `setMark()`, reopened when it errored/closed or the model changed. Any Realtime error drops it. The adapter has no `response.cancel`, so cancelling (or failing) a turn while a response is in flight closes and drops the session. Note: a reused session keeps its conversation history across turns.
- **B labelling.** Forced mode: the router's speech is the `ack`. Auto mode: the first delta's `kind` decides (`ack` if it called `ask_opus`, `answer` if it answered directly). The pre-warmed first TTS socket is opened as "ack"; its `*.ttsFirstByte` mark is renamed to the final label. The ack socket is flushed on `onSpokenEnd` (or when the router returns). The answer socket opens when Opus is requested (warm) or when the spoken line is ready (cold). Rare auto-mode "text, then tool call" turns are flagged `turn.end.meta.labelConflict`.
- **C pointing.** After release: commit Scribe, wait up to `hybridWaitMs` for its final (0 = don't wait), then `commitAndRespond(formatPointingContext(...) || undefined)`. `llm.request.meta` = `{pointingInjected, pointingMissed}`. A final that arrives after the response started is still resolved and recorded with `pointing.resolved.meta = {pointingMissed: true, late: true}`; one that never arrives (bounded by `hybridLateWaitMs`, 2 s after the reply) gets `{pointingMissed: true, arrived: false}`. A Scribe failure in C is non-fatal (`error {source:"scribe"}` + RunRecord.error, the voice reply still runs).
- **Cold (`prewarm: false`).** Sockets open on release (Scribe, Realtime) or when first needed (TTS), so setup is inside the measured latency; `llm.request.meta.cold = true` (also on `turn.end`). Cold Realtime sessions are closed after the turn.
- **Errors / cancel.** Any adapter failure → `error {source: scribe|openai|tts|haiku|opus|timeout}` and `done` resolves with `error` set. Overall turn timeout 60 s from `turn.start`. `cancel()` closes every socket opened for the turn (and the reusable Realtime session only if a response was in flight).
- **Headless check.** `npm run smoke:e2e` (real keys; SKIPs per approach) and `npm run smoke:e2e -- --fake` (fake adapters over the real `/ws`) print one RunRecord per approach with marks relative to release.

## 8. Decisions and alternatives

- **One server WebSocket for everything** (not browser WebRTC straight to OpenAI). Same network path for every approach, keys stay server-side, and every mark is instrumented in one place. A browser→OpenAI WebRTC variant of approach A is a follow-up, to measure how much the server hop costs.
- **Push-to-talk only.** It removes end-of-speech detection delay from every approach.
- **Replay mode is the source of truth** for benchmark numbers. Live mode is for feel.
- **Scribe `commit_strategy=manual`.** The release is the commit.
