# Vendor API notes

Checked 2026-10-13. **✅ = confirmed against the vendor's own docs. ⚠️ = not yet confirmed (none left after T1). 🔧 = the docs don't settle it, so there's a written workaround. ⚡ = a latency risk to measure.**

T1 (2026-10-13): no API keys were available, so every ✅ added by T1 is **confirmed from docs, not live**. Each one cites the page it came from. Docs that couldn't settle a question get a 🔧 **workaround** instead. The probe scripts `scripts/probe-openai-realtime.ts`, `scripts/probe-scribe.ts` and `scripts/probe-eleven-tts.ts` (run with `npx tsx …`) open the real sockets once keys exist, so re-run them and update this file if anything differs.

## Prices (for cost per turn)

| Item | Price | Status |
|---|---|---|
| Claude Haiku 5.5 (`claude-haiku-5-5`) | $0.10 in / $0.50 out per MTok (prompts ≤100K; $0.50/$2.50 above) | ✅ Anthropic docs |
| Claude Opus 5.5 (`claude-opus-5-5`) | $4 / $20 per MTok, cache reads $0.20; fast mode $8 / $40 | ✅ Anthropic docs |
| `gpt-realtime-2.1` | audio $32 in / $0.40 cached / $64 out; text $4 / $24 per MTok | ✅ developers.openai.com/api/docs/pricing |
| `gpt-realtime-2.1-mini` | audio $10 / $0.30 / $20; text $0.60 / $2.40 per MTok | ✅ same |
| `gpt-live-transcribe` | $0.017/min (not used; no word timestamps) | ✅ same |
| ElevenLabs Scribe v2 Realtime | $0.39/hr; keyterms +$0.08/hr | ✅ elevenlabs.io/pricing/api |
| ElevenLabs Eleven v4 Turbo / Flash | $0.04 per 1K characters | ✅ same |

Planning estimate for audio tokens: about 600 per minute of input and 1,200 per minute of output. That's an assumption; use the `usage` numbers the API actually returns.

## Anthropic (Claude)

Source: the bundled `claude-api` skill (cached 2026-10-06). TypeScript SDK `@anthropic-ai/sdk`.

**Haiku 5.5** ✅
- Adaptive thinking is on by default, and the effort default is `medium`. **Set `output_config: {effort: "low"}`** for the router.
- `temperature`, `top_p` and `top_k`: leave them out. Non-default values return a 400.
- Forced `tool_choice` (`{type:"tool", name}` or `any`) **is accepted**. The response then starts with the tool call and has no thinking block, which is the fastest path.
- No assistant prefill (400).
- Refusals: `stop_reason: "refusal"`. There's **no server-side fallback** for Haiku 5.5, so don't send `fallbacks`.
- Tokenizer produces about 30% more tokens than Haiku 4.5.

**Opus 5.5** ✅
- Thinking can't be disabled (`{type:"disabled"}` returns a 400). Control depth with `output_config.effort`. The default is `medium`, so set it explicitly.
- Forced `tool_choice` `any`/`tool` returns a 400. Use `auto`.
- Fast mode: beta endpoint `client.beta.messages.stream(...)`, `betas: ["fast-mode-2026-02-01"]`, `speed: "fast"`. Has its own rate limit; on a 429, fall back to standard speed. Switching speed invalidates the prompt cache.
- Refusal fallback (recommended): `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`. Always check `stop_reason` before reading content.
- Streaming + `stream.finalMessage()`. Thinking blocks come back with empty text by default (`display: "omitted"`), so the first text delta is what counts as `opus.firstToken`.

**General** ✅
- Tools with `eager_input_streaming: true` stream their input as it's generated. Validate the parsed input yourself (it may be truncated), and check `stop_reason` (`max_tokens`/`refusal`) before using it.
- Prompt caching: `cache_control: {type: "ephemeral"}` on the stable system prompt + fixture context. Check that `usage.cache_read_input_tokens > 0` on repeated runs.
- Credentials: if `ANTHROPIC_API_KEY` is unset, the SDK also picks up an `ant auth login` profile.

## OpenAI Realtime

- URL: `wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1` ✅ (or `gpt-realtime-2.1-mini`; both list `v1/realtime` as supported on their model pages).
- Auth: `Authorization: Bearer $OPENAI_API_KEY` ✅. **No `OpenAI-Beta` header** ✅ (docs, not live): the GA WebSocket guide's server-side examples send only `Authorization` plus an optional `OpenAI-Safety-Identifier`, and none of the realtime guides or references mention `OpenAI-Beta`. Source: realtime-websocket guide.
- Both models are **reasoning models** ✅. The session (and `response.create`) accepts `reasoning: {effort: "minimal"|"low"|"medium"|"high"|"xhigh"}`, and "higher reasoning effort can increase latency". The docs don't give a default, so **set it explicitly** (start with `"low"`) and record it in the run config. Source: model page + client-events reference.
- Every client event can carry an optional `event_id`, and the server echoes it in `error.event_id` if that event fails.

### Session config ✅ (docs, not live; client-events reference `session.update`)

The audio format is **nested**: `session.audio.input.format` / `session.audio.output.format` = `{type: "audio/pcm", rate: 24000}` (PCM is 24 kHz only; `audio/pcmu` and `audio/pcma` also exist). `turn_detection` lives under `audio.input`, and `null` turns VAD off ("the client must manually trigger model response"). `voice` lives under `audio.output`. Built-ins are `alloy ash ballad coral echo sage shimmer verse marin cedar`, and `marin`/`cedar` are recommended. **The voice can't change after the first audio output in a session.** `output_modalities` defaults to `["audio"]`, which means audio **plus** transcript. `["text"]` gives text only, and you can't ask for both. Only fields that are present get updated. `tool_choice` takes `"auto"|"none"|"required"` or `{type:"function", name}`.

```json
{"type":"session.update","session":{
  "type":"realtime",
  "instructions":"...",
  "output_modalities":["audio"],
  "audio":{
    "input":{"format":{"type":"audio/pcm","rate":24000},"turn_detection":null},
    "output":{"format":{"type":"audio/pcm","rate":24000},"voice":"marin"}
  },
  "reasoning":{"effort":"low"},
  "tools":[{"type":"function","name":"ask_opus","description":"...",
            "parameters":{"type":"object","properties":{"question":{"type":"string"}},"required":["question"]}}],
  "tool_choice":"auto"
}}
```
The server answers with `session.updated`, which carries the full effective config. Wait for `session.created` before sending.

### Client events ✅ (docs, not live; client-events reference)

```json
{"type":"input_audio_buffer.append","audio":"<base64 PCM16 24k>"}
{"type":"input_audio_buffer.commit"}
{"type":"input_audio_buffer.clear"}
{"type":"conversation.item.create","item":{"type":"message","role":"user","content":[{"type":"input_text","text":"Pointing: \"this\" → <button> ..."}]}}
{"type":"conversation.item.create","item":{"type":"function_call_output","call_id":"call_sHlR7iaFwQ2YQOqm","output":"<string, e.g. JSON>"}}
{"type":"response.create"}
```
- `append`: up to 15 MiB per event, and **the server doesn't acknowledge it**. `commit` errors if the buffer is empty. It creates a user item, replies with `input_audio_buffer.committed`, and **doesn't** start a response. `clear` replies with `input_audio_buffer.cleared`.
- Push-to-talk over WebSocket, per the realtime-conversations guide's "Push-to-talk" section: set `turn_detection: null`. On press, `response.cancel` any in-flight response (and `conversation.item.truncate` any audio that hasn't played yet). On release, `commit` and then `response.create`.
- For context items you can also use `role: "system"` (content type `input_text`), which the docs describe for "smaller updates" mid-conversation. Either role works for `commitAndRespond(extraContext)`. Pick one and keep it.
- `response.create` can take an optional `response: {instructions, tools, tool_choice, output_modalities, reasoning, metadata, conversation, input, ...}` that overrides the session for that one response.

### Out-of-band responses, metadata, cancel ✅ (docs + live, 2026-10-13)

- **Out-of-band:** `response.conversation: "none"` → the response "will not add items to default conversation" (allowed values `"auto"` (default) | `"none"`). `response.input` (array of items, incl. `{type:"item_reference", id}`) "creates a new context for this Response instead of using the default conversation"; `input: []` clears the context. Both field names confirmed in the realtime-conversations guide ("Create responses outside the default conversation") and the client-events reference.
- **Parallelism:** "Only one Response can write to the default Conversation at a time, but otherwise multiple Responses can be created in parallel." We still serialize everything in the adapter (one audio stream to play).
- **`metadata`** (≤16 string key/values) on `response.create` is echoed on `response.created` / `response.done` → `response.metadata` ✅ live. The adapter tags every create with `{kind, seq}`.
- **`reasoning: {effort: "minimal"}`** is accepted per response ✅ (enum `minimal|low|medium|high|xhigh`). Live, the 2.1 filler still reported `reasoning_tokens: 6`; mini reported none.
- **`response.cancel`** takes an optional `response_id`; **without it, it only cancels "an in-progress response in the default conversation"**, so an out-of-band filler must be cancelled by id (the adapter always sends the id, waiting for `response.created` if needed). The server answers with `response.done` `status: "cancelled"`, `status_details: {type:"cancelled", reason:"client_cancelled"}` ✅ live. With nothing to cancel it returns an `error` and the session is unaffected (the adapter swallows errors tied to its cancel event_id).
- Live filler (`conversation:"none"`, `input:[user "Say exactly this and nothing else: …"]`, `instructions` "say exactly…", `tool_choice:"none"`): said **verbatim** on both 2.1 and 2.1-mini ("Still checking the stylesheet."). `response.created.response.conversation_id` is `null` (in-band responses carry `conv_…`); no `conversation.item.added` is emitted, but a `conversation.item.done` still is. First audio ≈ 0.6–0.9 s after the create on an idle session; `usage.input_tokens` reported **0**.
- Live notice (user `input_text` note + `response.create {tool_choice:"none"}`): paraphrased naturally ("The CSS refactor is done. Three files changed, and the build passes."), first audio ≈ 0.6–0.7 s.
- Live cancel: after the first audio delta, 3 more audio deltas (~57 KB) of the cancelled response still arrived before its `response.done`; its transcript stops where it was cut. A new turn's `response.create` sent before that `done` is fine if serialized behind it (the adapter defers it); no stale audio reached the new turn. The cancelled partial assistant item stays in the conversation (not truncated to what was played; `conversation.item.truncate` would fix that, not done).
- A single response can contain two spoken `message` items; their transcripts concatenate with no separator ("…colors.I'd love…").

### Server events ✅ (docs, not live; server-events reference)

| What | Event | Payload fields |
|---|---|---|
| output audio chunk | `response.output_audio.delta` | `response_id, item_id, output_index, content_index, delta` (base64 PCM) |
| output audio finished | `response.output_audio.done` | ids only |
| spoken transcript (audio mode) | `response.output_audio_transcript.delta` / `.done` | `delta` / `transcript` |
| text (text-only mode) | `response.output_text.delta` / `.done` | `delta` / `text` |
| new output item | `response.output_item.added` / `.done` | `item` (a `message` or a `function_call` item) |
| tool args streaming | `response.function_call_arguments.delta` | `item_id, output_index, call_id, delta`. **No `name`.** |
| tool args complete | `response.function_call_arguments.done` | `item_id, call_id, name, arguments` (JSON string) |
| response finished | `response.done` | `response.{id,status,status_details,output[],usage,...}` |

Other events you'll see: `session.created`, `session.updated`, `conversation.item.added`, `conversation.item.done`, `input_audio_buffer.committed`, `input_audio_buffer.cleared`, `response.created`, `response.content_part.added`, `response.content_part.done`, `rate_limits.updated`. Ignore unknown types.

- **Where the tool name and call id appear first:** `response.output_item.added` with `item.type === "function_call"`. Per the schema, that item has `name`, `call_id`, `arguments` and `id`, but the reference example only shows a `message` item, so the probe checks this. Stamp `llm.toolCall` there. As a fallback, use the first `function_call_arguments.delta` and map `item_id` → name once `.done` arrives. A response can hold a spoken `message` item **and then** a `function_call` item, which is the ack-then-tool flow approach A relies on.
- `onText` in audio mode = `response.output_audio_transcript.delta`. `response.output_text.delta` only appears with `output_modalities: ["text"]`.
- Check `response.status` on `response.done`: `completed | cancelled | failed | incomplete`, with details in `status_details.{type,reason,error}`.
- **`usage` is on `response.done` → `response.usage`** (per response, not cumulative):
```json
"usage":{"total_tokens":253,"input_tokens":132,"output_tokens":121,
  "input_token_details":{"text_tokens":119,"audio_tokens":13,"image_tokens":0,"cached_tokens":64,
    "cached_tokens_details":{"text_tokens":64,"audio_tokens":0,"image_tokens":0}},
  "output_token_details":{"text_tokens":30,"audio_tokens":91}}
```
  Cost: bill (input text − cached text) × text-in, (input audio − cached audio) × audio-in, each cached count × the cached rate, and output text and output audio at their own rates. Prices are in the table above.
- **Error event:** most errors are recoverable, and the session stays open.
```json
{"event_id":"event_890","type":"error","error":{"type":"invalid_request_error","code":"invalid_event","message":"The 'type' field is missing.","param":null,"event_id":"event_567"}}
```

- T4 (live, 2026-10-13): with an **invalid key** the WebSocket upgrade still succeeds and the server sends an `error` event ("Incorrect API key provided") instead of an HTTP 401, so setup code must treat an `error` before `session.updated` as fatal.
- Don't confuse this with the separate "GPT-Live" WebSocket at `wss://api.openai.com/v1/live/sessions`, which has different event names (`session.output_audio.delta`, …). We use `/v1/realtime`.

## ElevenLabs Scribe v2 Realtime (STT) ✅

- URL: `wss://api.elevenlabs.io/v1/speech-to-text/realtime` (regional: `api.us.elevenlabs.io`, EU/IN/SG residency hosts)
- Auth: header `xi-api-key`, or `?token=` with a single-use token (`/docs/api-reference/tokens/create`)
- Query params we use: `model_id=scribe_v2_realtime`, `audio_format=pcm_24000`, `commit_strategy=manual`, `include_timestamps=true`, optional `language_code=en`, `keyterms` (≤50, ≤20 chars each), `keepalive_interval_ms`
- `keyterms` is an array, sent as a **repeated query param** (`&keyterms=Opus&keyterms=Vite`) ✅. Source: the official `@elevenlabs/client` `scribe.ts` builds it that way, and its CHANGELOG says "passed as repeated query params".
- Client message (required fields: `message_type, audio_base_64, commit, sample_rate`):
  ```json
  {"message_type":"input_audio_chunk","audio_base_64":"...","commit":false,"sample_rate":24000}
  ```
  `previous_text` is allowed **only on the first chunk**. To commit on release, send a chunk with `"commit": true`.
- **Commit with an empty `audio_base_64` is accepted** ✅ (docs + official SDK, not live). ElevenLabs' own client `RealtimeConnection.commit()` (`elevenlabs/packages`, `packages/client/src/scribe/connection.ts`) sends exactly this:
  ```json
  {"message_type":"input_audio_chunk","audio_base_64":"","commit":true,"sample_rate":24000}
  ```
  The probe sends the same thing.
- Server messages: `session_started {session_id, config}`, `partial_transcript {text}`, `committed_transcript {text}`, `committed_transcript_with_timestamps {text, language_code, words[]}`, optional `committed_transcript_entities` / `edited_transcript`, `warning {warning}`, plus errors. Error messages look like `{"message_type":"<error type>","error":"<message>"}`. Types: `auth_error, quota_exceeded, transcriber_error, input_error, invalid_request, error, commit_throttled, unaccepted_terms, rate_limited, queue_overflow, resource_exhausted, session_time_limit_exceeded, chunk_size_exceeded, insufficient_audio_activity`. "An error message will be returned before the WebSocket connection is closed." Source: realtime event reference + API reference.
- `words[]` items: `{text, start, end, type: "word"|"spacing"|"audio_event", speaker_id?, logprob?, characters?}`. `start`/`end` are in seconds. Filter to `type === "word"`. (`audio_event` is for laughter and similar sounds; the live AsyncAPI contract at `api.elevenlabs.io/speech-to-text-asyncapi.yml` lists it.)
- **`include_timestamps=true` produces `committed_transcript_with_timestamps` in addition to `committed_transcript`** ✅ (docs, not live). The event reference says "Sent **after** the committed transcript. Only received when `include_timestamps=true` or `include_language_detection=true`". The live contract describes it as "a **delayed** committed_transcript_with_timestamps message … an additional message with timestamps after each commit". So expect `committed_transcript` first and the timestamped one shortly after. Resolve `final()` on the timestamped one, and fall back to the plain text on a timeout (T3: 3 s). Log the gap between the two, because it's part of `stt.final` latency.
- 🔧 **Whether `start`/`end` reset per commit or keep counting for the whole session isn't documented.** The reference only says "Start time in seconds", and the earlier claim here ("seconds from the start of the session's audio") isn't stated anywhere I could find. **Workaround:** **one Scribe session per turn** with exactly **one commit** (on release), opened at `press`. Either way, the times are then relative to the first audio chunk sent in that session, which equals `tAudioStart` as long as the adapter forwards audio from the first captured sample. Record the session setup time. `probe-scribe.ts` commits twice in one session and prints `CUMULATIVE` or `RESETS` (it needs speech: set `PROBE_WAV` to a 24 kHz mono WAV).
- Timestamps come only with **committed** segments. Partials are text only.
- ⚡ Latency risk (docs): "Transcript processing starts after the first 2 seconds of audio are sent", and the server "buffers the first ~2 seconds of audio before transcribing". Expect **no partials during the first ~2 s** of a per-turn session. A manual commit should force processing of a shorter clip, but measure `release → stt.final` on short utterances (U-fixtures under 2 s). Source: "Transcripts and commit strategies" guide.
- Other facts: "Committing manually several times in a short sequence can degrade model performance" (and can trigger `commit_throttled`). The server closes the socket after **15 s with no client messages**. Recommended chunk size is 0.1–1 s. The official SDK also knows about `final_transcript` and `final_transcript_with_timestamps` events, which the public docs say aren't emitted, so ignore unknown `message_type`s.

## ElevenLabs TTS (Eleven v4 Turbo)

- Model IDs ✅: `eleven_v4_turbo` (~100 ms model latency, 90+ languages, audio tags, recommended for Agents), `eleven_flash_v2_5` (~75 ms, 32 languages, doesn't normalize numbers by default), `eleven_v3_conversational` (~280 ms).
- One third-party benchmark (via Cartesia, a competitor) reported >1 s P90 time-to-first-audio for ElevenLabs. Measure it ourselves.

### ❗ `eleven_v4_turbo` is NOT available on the TTS `stream-input` WebSocket ✅ (docs, not live)

- TTS WebSocket guide: the `/v1/text-to-speech/{voice_id}/stream-input` endpoint "does **not** support the `eleven_v3` or `eleven_v4` models".
- "TTS vs TTD WebSockets" guide, comparison table: "**No** `eleven_v3` or `eleven_v4` on this endpoint". Text to Dialogue: "`model_id` must start with `eleven_v3` or `eleven_v4` (for example `eleven_v4` or `eleven_v4_turbo`)".
- Models page: "Eleven v4 Turbo is available via the **Text to Dialogue websocket**."
- So the adapter speaks **two protocols** behind the same `TtsStream`. `eleven_flash_v2_5` uses the TTS WebSocket (below). `eleven_v4_turbo` uses the **Text to Dialogue (TTD) WebSocket** (further below). `probe-eleven-tts.ts` case B checks how the server rejects v4 Turbo on `stream-input`.

### TTS WebSocket (`eleven_flash_v2_5`) ✅ (docs, not live; stream-input API reference + "Generate audio in real-time" guide)

- URL: `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input?model_id=eleven_flash_v2_5&output_format=pcm_24000`. Regional hosts are the same as for Scribe. Other query params: `inactivity_timeout` (default 20, max 180 s), `sync_alignment` (default false), `auto_mode` (default false; the latency guide says it "automatically handles generation triggers, removing the need to manually manage chunk strategies"), `language_code`, `apply_text_normalization`, `enable_ssml_parsing`, `seed`, `enable_logging`.
- `output_format`: the WS schema says "Any type". `pcm_24000` is an allowed value on the HTTP endpoints (`pcm_8000…pcm_48000`, `mp3_*`, `opus_*`, `ulaw_8000`, `alaw_8000`), and the probe confirms it works on WS.
- Auth: `xi-api-key` header (what we use), **or** `xi_api_key` / `authorization` in the **first message only**, or `single_use_token` / `authorization` query params.
- Client messages, in order:
```json
{"text":" ","voice_settings":{"stability":0.5,"similarity_boost":0.8,"use_speaker_boost":false,"speed":1.0},"generation_config":{"chunk_length_schedule":[120,160,250,290]}}
{"text":"Sure, one sec. "}
{"text":"The header is sticky ","try_trigger_generation":false}
{"text":" ","flush":true}
{"text":""}
```
  The first message's `text` **must be a single space**. Each text chunk "should always end with a single space". `voice_settings` / `generation_config` can only be set in the first message. `chunk_length_schedule` values are 50–500, and the default `[120,160,250,290]` means **no audio until 120 characters are buffered**, so for a short ack use smaller values, `auto_mode=true`, or `flush`. `flush: true` forces generation of whatever is buffered and keeps the socket open. `{"text":""}` is end-of-stream: the server flushes, sends `isFinal`, and closes. To keep a socket open, send `{"text":" "}` before `inactivity_timeout` runs out.
- Server messages (**camelCase**):
```json
{"audio":"<base64 PCM>","normalizedAlignment":{"chars":["H","i"],"charStartTimesMs":[0,3],"charDurationsMs":[3,5]},"alignment":{"chars":[...],"charStartTimesMs":[...],"charDurationsMs":[...]}}
{"isFinal":true}
```
  Alignment times are "relative to the returned chunk … not the full audio response". The schema says `audio` is null when `isFinal` is true, so treat a falsy `audio` as "no bytes".
- 🔧 Segment end: the docs only document `isFinal` after end-of-stream (`{"text":""}`), not after a mid-stream `flush`. **Workaround:** one socket per segment (`ack`, `answer`). `flush()` sends `{"text":" ","flush":true}` and then `{"text":""}`, and `done()` resolves on `isFinal` or socket close. Pre-open the next segment's socket to hide connection setup. An open, idle TTS socket doesn't count toward concurrency.

### Multi-context TTS WebSocket (flash only) ✅ (docs, not live; multi-stream-input API reference + guide)

- URL: `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/multi-stream-input?model_id=eleven_flash_v2_5&output_format=pcm_24000`, with the same query params and auth as above. **At most 5 concurrent contexts** per connection. It's the same model family as stream-input, so it's **not usable with v4 Turbo**.
```json
{"text":" ","context_id":"ack","voice_settings":{...},"generation_config":{...}}
{"text":"One sec. ","context_id":"ack"}
{"context_id":"ack","flush":true}
{"context_id":"ack","close_context":true}
{"context_id":"answer","text":""}
{"close_socket":true}
```
  `{"context_id":X,"text":""}` is a **keep-alive** for that context (each context times out after `inactivity_timeout`, default 20 s). It doesn't close anything. Use `close_context` to end one context and `close_socket` to end all of them.
- Server: `{"audio":"…","normalizedAlignment":…,"alignment":…,"contextId":"ack"}` and `{"isFinal":true,"contextId":"ack"}`. The reference schema uses camelCase `isFinal`, but the guide's sample code checks `is_final`, so **accept both**. This lets ack and answer share one socket for flash (close the ack context → `isFinal` for ack = segment done).

### Text to Dialogue WebSocket (`eleven_v4_turbo`) ✅ (docs, not live; TTD WebSocket API reference + "Stream dialogue in real-time" guide)

- URL: `wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input?model_id=eleven_v4_turbo&output_format=pcm_24000`. Other query params: `sync_alignment`, `language_code`, `apply_text_normalization`, `seed`, `enable_logging`. The default model is `eleven_v3_conversational`, so **always pass `model_id`**.
- Auth: `xi-api-key` / `Authorization` header, `single_use_token` query param, or `xi_api_key` / `authorization` / `single_use_token` in the first message.
- Client messages. **Different shape from TTS**: no voice in the URL, no `chunk_length_schedule`, and `voice_settings` only takes `stability`.
```json
{"voices":["<voice_id>"],"voice_settings":{"stability":0.5}}
{"inputs":[{"text":"Sure, one sec. ","voice_id":"<voice_id>"}]}
{"inputs":[{"text":"The header is sticky.","voice_id":"<voice_id>","new_turn":false}]}
{"flush":true}
{"keep_alive":true}
{"close_socket":true}
```
  The first message **must** include `voices`, and with `eleven_v4_turbo` it must be **exactly one** voice. Don't resend `voices`, credentials or `voice_settings` after the first message. The server buffers until it has "roughly 40 characters and 8 words" (a fixed threshold) before it emits audio, unless you `flush`. `new_turn: true` finalizes the pending segment. The inactivity limit is a **fixed 20 s** (`keep_alive` resets it). `close_socket` flushes, sends the remaining audio, then `is_final`, then closes.
- Server messages (**snake_case**):
```json
{"audio":"<base64 PCM>","alignment":{"chars":[...],"char_start_times_ms":[...],"char_durations_ms":[...]},"normalized_alignment":null}
{"is_final_audio_for_turn":true}
{"is_final":true}
{"message":"…","error":"authentication_required","code":<ws close code>,"param":null}
```
  Errors carry the WebSocket close code that follows them. `normalized_alignment` is "reserved, currently unused".
- 🔧 Segment end: `is_final_audio_for_turn` ("the final audio for a given turn has been sent") isn't documented to fire after a plain `flush`, so the probe logs whether it does. **Workaround** (same as TTS): one TTD socket per segment, `flush()` → `{"flush":true}` + `{"close_socket":true}`, and `done()` resolves on `is_final` or close.
- **Concurrency differs:** "Each open connection holds one dialogue session for its whole lifetime", from a separate pool (plan-dependent). Pre-warmed idle TTD sockets **do** use up dialogue sessions. Close them promptly. Keep at most two per browser session (current segment + next).
- **TTD multi-context (`/v1/text-to-dialogue/multi-stream-input`) is v3-only:** "`model_id` must start with `eleven_v3`". So ack and answer **can't share one socket with v4 Turbo**. Use one socket per segment.

### HTTP streaming fallback ✅ (docs, not live; "Stream speech" / "Stream dialogue" API references)

- Flash: `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream?output_format=pcm_24000`, header `xi-api-key`, body `{"text":"…","model_id":"eleven_flash_v2_5","voice_settings":{…},"previous_text":"…","next_text":"…"}` → a raw audio byte stream.
- v4 family: `POST https://api.elevenlabs.io/v1/text-to-dialogue/stream?output_format=pcm_24000`, body `{"inputs":[{"text":"…","voice_id":"…"}],"model_id":"eleven_v4_turbo","previous_text":"…"}` (`previous_text` / `future_text` ≤100 chars, "not supported by every model"; keep the total under 2,000 chars). 🔧 The models page only promises v4 Turbo on the TTD **WebSocket** (and plain `eleven_v4` on the TTD HTTP API), so whether HTTP TTD accepts `eleven_v4_turbo` is **unconfirmed**. Only use it if the WebSocket path fails, and check it with one request first.
- The adapter interface in ARCHITECTURE §4 (`model: "eleven_v4_turbo" | "eleven_flash_v2_5"`) still works. `elevenTts.ts` switches protocol on `model`.

## Live checks (2026-10-13, with real keys)

- **Claude goes through OpenRouter**, not the Anthropic API. OpenRouter serves an Anthropic-compatible Messages API at `https://openrouter.ai/api` (`/v1/messages`), so the Anthropic SDK works with `baseURL` + `authToken: OPENROUTER_API_KEY`. Model IDs: `anthropic/claude-haiku-5.5`, `anthropic/claude-opus-5.5` (same prices as Anthropic). `server/adapters/claude.ts` picks OpenRouter whenever `OPENROUTER_API_KEY` is set (`CLAUDE_PROVIDER=anthropic` forces direct).
  - ✅ Works: streaming, forced `tool_choice`, `eager_input_streaming` (`input_json_delta`), `output_config.effort`, `cache_control` (second Opus run read 9,215 cached tokens).
  - ❌ `fallbacks: "default"` → 400 (OpenRouter expects an array). The refusal fallback is Anthropic-direct only; `stop_reason` is still checked.
  - ⚠️ `speed: "fast"` is accepted but `usage.speed` comes back `"standard"`: **Opus fast mode does not apply via OpenRouter.** Cost follows `usage.speed`.
  - The first request after a while can be slow (one Haiku call took 20.9 s, the next 1.4 s).
- ✅ Scribe: timestamped commit arrives ~15–20 ms after the plain one; release → final ≈ 200–380 ms on `hello.wav`.
- ✅ OpenAI Realtime GA session/event shapes work as documented; tool name/call_id arrive on `response.output_item.added`.
- ✅ OpenAI Realtime out-of-band filler responses (said verbatim), notices, `metadata` echo and `response.cancel {response_id}` + reuse after `beginTurn()`: see §OpenAI Realtime "Out-of-band responses, metadata, cancel" (`npm run smoke:realtime` cases 3–4).
- ✅ ElevenLabs `output_format=pcm_24000` works on both the v4 Turbo dialogue WebSocket and the Flash stream-input WebSocket (output verified as speech, not noise).

## OpenAI TTS (`tts-1`) ✅ (docs, and live in `npm run bench:tts`)

- Model page: "optimized for realtime text-to-speech"; **$15 per 1M characters**; endpoint `POST /v1/audio/speech` only. Rate limits by tier (Build 2,500 RPM). Source: https://developers.openai.com/api/docs/models/tts-1
- Request: `{"model":"tts-1","input":"…","voice":"coral","response_format":"pcm"}` with `Authorization: Bearer $OPENAI_API_KEY`. Voices for tts-1 / tts-1-hd: `alloy ash coral echo fable onyx nova sage shimmer` (not ballad/verse/marin/cedar); "voices are currently optimized for English". Source: https://developers.openai.com/api/docs/guides/text-to-speech
- `pcm` = "raw samples in 24kHz (16-bit signed, low-endian), without the header" — mono in practice — exactly the lab's format. Streams via chunked transfer encoding; the guide recommends `wav`/`pcm` "for the fastest response times". No streaming *text* input: the adapter sends a sentence at a time.
- Live: ~1.1–1.3 s from the first text pushed to the first PCM byte (sentence wait + request). Policy: tell end users the voice is AI-generated.

## Local TTS: Kokoro and Piper ✅ (installed and run locally)

- Setup: `npm run setup:local-tts` → `.venv-tts` (Python 3.12 via uv: `kokoro-onnx` 0.6, `onnxruntime` 1.31, `piper-tts` 1.8) and `.models/` (gitignored).
- **Kokoro-82M** (Apache-2.0): `kokoro-v1.0.onnx` (310 MB) + `voices-v1.0.bin` (26 MB) from the kokoro-onnx `model-files-v1.0` release. `Kokoro.create_stream(text, voice, lang)` yields float32 at 24 kHz. Voices used: `af_heart` (en); no Romanian voice — `lang="ro"` (espeak-ng phonemes) with `if_sara`. CPU (CoreML EP partial, not faster).
- **Piper** (OHF-Voice piper1): voices from `huggingface.co/rhasspy/piper-voices` — `en_US-lessac-medium`, `ro_RO-mihai-medium` (60 MB each + `.onnx.json`). `PiperVoice.synthesize(text)` yields one `AudioChunk` (int16, 22.05 kHz) per sentence → resampled to 24 kHz.
- Both run in `tools/localtts/server.py` (one persistent process per engine, framed PCM like tools/mactts), started by `npm run dev` (`LOCAL_TTS=0` skips local engines).

## Sources
- Anthropic: bundled `claude-api` skill (models, Haiku 5.5 / Opus 5.5 migration notes)
- OpenAI pricing: https://developers.openai.com/api/docs/pricing
- OpenAI Realtime WS guide: https://developers.openai.com/api/docs/guides/realtime-websocket
- OpenAI realtime transcription guide: https://developers.openai.com/api/docs/guides/realtime-transcription
- ElevenLabs models: https://elevenlabs.io/docs/overview/models
- ElevenLabs pricing: https://elevenlabs.io/pricing/api
- ElevenLabs realtime STT API: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
- OpenAI Realtime conversations guide (session example, function calling, push-to-talk): https://developers.openai.com/api/docs/guides/realtime-conversations
- OpenAI Realtime client events: https://developers.openai.com/api/reference/resources/realtime/client-events
- OpenAI Realtime server events: https://developers.openai.com/api/reference/resources/realtime/server-events
- OpenAI model pages: https://developers.openai.com/api/docs/models/gpt-realtime-2.1 , https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini
- (Tip: OpenAI docs pages return raw markdown if you append `.md` to the URL; ElevenLabs pages do the same, and its index is https://elevenlabs.io/docs/llms.txt)
- ElevenLabs Scribe transcripts and commit strategies: https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies
- ElevenLabs Scribe realtime event reference: https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/event-reference
- ElevenLabs Scribe live AsyncAPI contract: https://api.elevenlabs.io/speech-to-text-asyncapi.yml
- ElevenLabs official client (Scribe `commit()`, keyterms encoding): https://github.com/elevenlabs/packages/blob/main/packages/client/src/scribe/connection.ts and `.../scribe/scribe.ts`
- ElevenLabs TTS stream-input: https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input
- ElevenLabs TTS WebSocket guide: https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts
- ElevenLabs TTS multi-context: https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input , guide: https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/multi-context-web-socket
- ElevenLabs TTS vs TTD WebSockets: https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/tts-vs-ttd-websockets
- ElevenLabs Text to Dialogue WebSocket: https://elevenlabs.io/docs/api-reference/text-to-dialogue/ttd-websocket , guide: https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tdd
- ElevenLabs TTD multi-context (v3 only): https://elevenlabs.io/docs/api-reference/text-to-dialogue/ttd-multi-websocket
- ElevenLabs HTTP streaming: https://elevenlabs.io/docs/api-reference/text-to-speech/stream , https://elevenlabs.io/docs/api-reference/text-to-dialogue/stream
- ElevenLabs latency optimization (`auto_mode`): https://elevenlabs.io/docs/eleven-api/guides/how-to/best-practices/latency-optimization
