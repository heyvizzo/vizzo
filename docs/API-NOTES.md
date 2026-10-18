# Vendor API notes

Checked 2026-10-13. **✅ = confirmed against the vendor's own docs. ⚠️ = not yet confirmed (none left after T1). 🔧 = the docs don't settle it, so there's a written workaround. ⚡ = a latency risk to measure.**

T1 (2026-10-13): no API keys were available, so every ✅ added by T1 is **confirmed from docs, not live**. Each one cites the page it came from. Docs that couldn't settle a question get a 🔧 **workaround** instead. The probe scripts `scripts/probe-scribe.ts` and `scripts/probe-eleven-tts.ts` (run with `npx tsx …`) open the real sockets once keys exist, so re-run them and update this file if anything differs.

## Prices (for cost per turn)

| Item | Price | Status |
|---|---|---|
| Claude Haiku 5.5 (`claude-haiku-5-5`) | $0.10 in / $0.50 out per MTok (prompts ≤100K; $0.50/$2.50 above) | ✅ Anthropic docs |
| Claude Opus 5.5 (`claude-opus-5-5`) | $4 / $20 per MTok, cache reads $0.20; fast mode $8 / $40 | ✅ Anthropic docs |
| `gpt-live-transcribe` | $0.017/min (not used; no word timestamps) | ✅ developers.openai.com/api/docs/pricing |
| ElevenLabs Scribe v2 Realtime | $0.39/hr; keyterms +$0.08/hr | ✅ elevenlabs.io/pricing/api |
| ElevenLabs Eleven v4 Turbo / Flash | $0.04 per 1K characters | ✅ same |
| Fish Audio Drama 3 via OpenRouter (TTS) | $2 per 1M characters (measured) | ✅ generation cost |
| ElevenLabs v4 Turbo / Flash via OpenRouter | $20 per 1M characters (catalog; direct page says $40 per 1M, see the `elevenPerChar` note in cost.ts) | ⚠️ conflict |
| Whisper large v3 via OpenRouter (STT, batch) | $0.000025 per audio second (measured) | ✅ generation cost |
| Fish Transcribe 1 via OpenRouter (STT, batch) | $0.0001 per audio second (catalog) | ✅ catalog |
| Nemotron 3.5 ASR via OpenRouter (STT, batch) | $0.00000333 per audio second (measured) | ✅ generation cost |

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
- Streaming + `stream.finalMessage()`. Thinking blocks come back with empty text by default (`display: "omitted"`), so the first text delta is what counts as `solver.firstToken`.

**General** ✅
- Tools with `eager_input_streaming: true` stream their input as it's generated. Validate the parsed input yourself (it may be truncated), and check `stop_reason` (`max_tokens`/`refusal`) before using it.
- Prompt caching: `cache_control: {type: "ephemeral"}` on the stable system prompt + fixture context. Check that `usage.cache_read_input_tokens > 0` on repeated runs.
- Credentials: if `ANTHROPIC_API_KEY` is unset, the SDK also picks up an `ant auth login` profile.

## OpenAI Realtime

Removed on 2026-10-17 with approaches A and C (git history has the notes and the adapter).

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

## Fast tier on a model API (2026-10-19, with real keys)

`server/adapters/llmApi.ts`: the router and progress lines can call a model API directly (OpenRouter, Fireworks, Cerebras, OpenAI, Z.ai over streamed Chat Completions; Anthropic through the SDK). `npm run bench:harness -- --fast <provider:model:level> --router 4 --fillers 1 --solver 0`, router p50 over 8 calls (API calls have no warm agent, so warm and cold are the same request):

| fast tier | first token | decision | total |
|---|---|---|---|
| OpenRouter `openai/gpt-oss-120b` · low | 904–1264 ms | 1008–1380 ms | 1293–1628 ms |
| OpenRouter `anthropic/claude-haiku-5.5` · off | 675–739 ms | 820–873 ms | 1188–1277 ms |
| OpenAI `gpt-6-luna` · none | 771–852 ms | 836–897 ms | 1413–1433 ms |
| Claude Code `claude-haiku-5-5` · low, warm agent | 757 ms | 943 ms | 1664 ms |
| Claude Code `claude-haiku-5-5` · low, cold | 1399 ms | 1592 ms | 2111 ms |

- ✅ Haiku over OpenRouter with thinking off reaches the decision about as fast as a warm `claude -p` agent and finishes ~0.4 s sooner, with no agent to keep warm, but it's billed per call (the harness runs on the subscription).
- gpt-oss-120b over OpenRouter varies more (one call took 2.8 s to its first token). Cerebras, Fireworks and Z.ai weren't measured (no keys yet).

## Live checks (2026-10-13, with real keys)

- **Claude goes through OpenRouter**, not the Anthropic API. OpenRouter serves an Anthropic-compatible Messages API at `https://openrouter.ai/api` (`/v1/messages`), so the Anthropic SDK works with `baseURL` + `authToken: OPENROUTER_API_KEY`. Model IDs: `anthropic/claude-haiku-5.5`, `anthropic/claude-opus-5.5` (same prices as Anthropic). `server/adapters/claude.ts` picks OpenRouter whenever `OPENROUTER_API_KEY` is set (`CLAUDE_PROVIDER=anthropic` forces direct).
  - ✅ Works: streaming, forced `tool_choice`, `eager_input_streaming` (`input_json_delta`), `output_config.effort`, `cache_control` (second Opus run read 9,215 cached tokens).
  - ❌ `fallbacks: "default"` → 400 (OpenRouter expects an array). The refusal fallback is Anthropic-direct only; `stop_reason` is still checked.
  - ⚠️ `speed: "fast"` is accepted but `usage.speed` comes back `"standard"`: **Opus fast mode does not apply via OpenRouter.** Cost follows `usage.speed`.
  - The first request after a while can be slow (one Haiku call took 20.9 s, the next 1.4 s).
- ✅ Scribe: timestamped commit arrives ~15–20 ms after the plain one; release → final ≈ 200–380 ms on `hello.wav`.
- ✅ ElevenLabs `output_format=pcm_24000` works on both the v4 Turbo dialogue WebSocket and the Flash stream-input WebSocket (output verified as speech, not noise).

## OpenAI TTS (`tts-1`) ✅ (docs, and live in `npm run bench:tts`)

- Model page: "optimized for realtime text-to-speech"; **$15 per 1M characters**; endpoint `POST /v1/audio/speech` only. Rate limits by tier (Build 2,500 RPM). Source: https://developers.openai.com/api/docs/models/tts-1
- Request: `{"model":"tts-1","input":"…","voice":"coral","response_format":"pcm"}` with `Authorization: Bearer $OPENAI_API_KEY`. Voices for tts-1 / tts-1-hd: `alloy ash coral echo fable onyx nova sage shimmer` (not ballad/verse/marin/cedar); "voices are currently optimized for English". Source: https://developers.openai.com/api/docs/guides/text-to-speech
- `pcm` = "raw samples in 24kHz (16-bit signed, low-endian), without the header" — mono in practice — exactly the lab's format. Streams via chunked transfer encoding; the guide recommends `wav`/`pcm` "for the fastest response times". No streaming *text* input: the adapter sends a sentence at a time.
- Live: ~1.1–1.3 s from the first text pushed to the first PCM byte (sentence wait + request). Policy: tell end users the voice is AI-generated.

## Fish Audio Drama 3 via OpenRouter (`fish-audio/drama-3`) ✅ (live, 2026-10-14)

- Endpoint `POST https://openrouter.ai/api/v1/audio/speech`, `Authorization: Bearer $OPENROUTER_API_KEY`. Body `{"model":"fish-audio/drama-3","input":"…","response_format":"pcm"}`. The voice is a provider-specific id (`voice`); the adapter omits it unless `FISH_VOICE_ID` is set. Voice selection is **not yet verified live**.
- Output: raw PCM with `Content-Type: audio/pcm;rate=44100;channels=1`. **44.1 kHz, not 24 kHz**: `server/adapters/fishTts.ts` reads the rate from the header and resamples (`pcmResample.ts`). Streams, so the first chunk arrives before the response ends.
- Latency, 126-character sentence, 3 runs: time to first byte 0.33–0.54 s, full response 1.14–1.39 s. In the adapter (sentence split, 9.2 s of audio out): first audio 595 ms, total 1.57 s.
- Price: **$2 per 1M characters**. Measured: `GET /api/v1/generation?id=…` reports `usage: 0.000252` for 126 characters. Catalog `pricing.prompt` is `0.000002` per character.
- Fish's own API (`api.fish.audio`, model header `drama-3`) is not used. Its published prices conflict ($10/1M launch promo, $15, $50 list), and OpenRouter's is lower and measured.

## Whisper large v3 via OpenRouter (`openai/whisper-large-v3`) ✅ (live, 2026-10-14)

- Endpoint `POST https://openrouter.ai/api/v1/audio/transcriptions`, JSON body `{"model","input_audio":{"data":<base64 wav>,"format":"wav"},"response_format":"verbose_json","timestamp_granularities":["word"],"language"?}`. Response: `{text, language, duration, words:[{word,start,end}], usage:{seconds,cost}}`.
- **Batch only**: one response after the whole clip is sent. No streaming, no partials. Upstream timeout 60 s; multipart / base64 JSON cap 25 MB (about 8.7 min of 24 kHz PCM16).
- `verbose_json` with word timestamps is what the pointing logic needs. `openai/gpt-4o-transcribe` and `gpt-4o-mini-transcribe` reject `verbose_json`, so they have no word timing.
- Latency (from the dev machine): 3-second clip, 5 runs: 0.5–2.4 s, with two outliers at 6.1 s and 11.5 s. 9.2-second clip through the adapter: 3.1 s from commit to final. Scribe's release-to-final latency is not measured in this repo.
- Price: **$0.000025 per audio second** (≈ $0.09/hour). Measured from `usage.cost` on the generation. The catalog lists `pricing.prompt` as `0.0000075`, which doesn't match; the billed cost is what counts.
- Compared with Scribe v2 Realtime at $0.39/hour (`scribePerSecond`), Whisper is about 4× cheaper. OpenRouter lists Scribe v2 (batch) at $0.11/hour.
- Compared with `openai/gpt-4o-mini-transcribe`: measured $0.00026 for 8.4 s (≈ $0.11/min), 0.7–1.8 s latency for 3 s clips. Cheaper per second than Scribe, but no word timing.

## OpenRouter STT: word timestamps and latency ✅ (live, 2026-10-14)

Same 9 s clip (Drama 3 output, 24 kHz) and `verbose_json` + `timestamp_granularities: ["word"]` for all four. Models that return word timings: **4 of 4 tested** (Whisper, Fish Transcribe 1, Fish Transcribe 1 Pro, Nemotron).

| Model (OpenRouter id) | Word timestamps | Streaming | Price (per audio s) | Notes |
|---|---|---|---|---|
| `openai/whisper-large-v3` | ✅ | ❌ batch | $0.000025 (measured) | Words come with a leading space; the adapter trims them |
| `fish-audio/transcribe-1` | ✅ + segments | ❌ batch | $0.0001 (catalog; 9 s clip billed as 9 s) | **Used.** Plain text, language detected. **Ignores `language`**: chat logs show Chinese / Macedonian / Italian text with en or ro pinned |
| `fish-audio/transcribe-1-pro` | ✅ + segments | ❌ batch | $0.0001 (catalog) | Puts `<|speaker:0|>` into the text, so not used for the transcript |
| `nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b` | ✅ | ❌ on OpenRouter | $0.00000333 (measured `usage.cost`; catalog agrees) | "Streaming" model, but served through the same batch endpoint: `stream: true` is ignored and the response is one JSON body. DeepInfra is the only provider. |

- Latency, one run each on the 3.4 s clip through the adapter, from commit to final: Fish 0.81 s, Nemotron 1.07 s, Whisper 2.5 s. Repeated 3 s clips: Fish 0.66–0.76 s, Nemotron 1.28–1.50 s, Whisper 0.5–3.8 s (noisy).
- Nothing on OpenRouter's STT endpoint streams. Live partials stay with ElevenLabs Scribe (WebSocket). Streaming Nemotron would need DeepInfra's own API, which this app doesn't use.
- "Fish Audio S2" isn't in OpenRouter's STT catalog. The Fish models are Transcribe 1 and Transcribe 1 Pro; Transcribe 1 is the one wired in.

## Local TTS: Kokoro and Piper ✅ (installed and run locally)

- Setup: `npm run setup:local-tts` → `.venv-tts` (Python 3.12 via uv: `kokoro-onnx` 0.6, `onnxruntime` 1.31, `piper-tts` 1.8) and `.models/` (gitignored).
- **Kokoro-82M** (Apache-2.0): `kokoro-v1.0.onnx` (310 MB) + `voices-v1.0.bin` (26 MB) from the kokoro-onnx `model-files-v1.0` release. `Kokoro.create_stream(text, voice, lang)` yields float32 at 24 kHz. Voices used: `af_heart` (en); no Romanian voice — `lang="ro"` (espeak-ng phonemes) with `if_sara`. CPU (CoreML EP partial, not faster).
- **Piper** (OHF-Voice piper1): voices from `huggingface.co/rhasspy/piper-voices` — `en_US-lessac-medium`, `ro_RO-mihai-medium` (60 MB each + `.onnx.json`). `PiperVoice.synthesize(text)` yields one `AudioChunk` (int16, 22.05 kHz) per sentence → resampled to 24 kHz.
- Extra Piper voices installed: en_US lessac/ryan/ljspeech (high), en_GB cori (high), en_US amy, hfc_female, hfc_male, libritts_r (904 speakers, speaker 0), en_GB alba, jenny_dioco (medium). Catalogue: `rhasspy/piper-voices/voices.json`. `{"cmd":"load","voice":…}` preloads one; requests carry `"voice"`.
- Both run in `tools/localtts/server.py` (one persistent process per engine, framed PCM like tools/mactts), started by the server only when selected as the Voice (server/speechEngines.ts; `LOCAL_TTS=0` skips that).

## Local STT: Parakeet, Apple SpeechTranscriber, WhisperKit, Moonshine ✅ (installed and run locally, 2026-10-17)

All four return word timestamps (seconds from the first sample, like Scribe), so pointing works with each. Free; the
Chat cost line shows them as saved vs Scribe. `npm run setup:local-stt` → `.venv-stt` (Python 3.12 via uv:
`parakeet-mlx` 0.5.3, `moonshine-voice` 0.1.5), `whisperkit-cli` 1.1.1 (Homebrew), models in `.models/` (gitignored).
Only the selected Speech model's helper runs (server/speechEngines.ts: saved in ~/.config/realtime-voice/speech-selection.json, switched from Settings, which shows loading / load time / RAM; `LOCAL_STT=0` skips starting it ahead of a turn). Adapter: `server/adapters/localStt.ts`.
- RAM: `ps` RSS misses MLX's GPU memory (Parakeet: 42 MB RSS vs 2.3 GB footprint). server/memory.ts counts each process's `phys_footprint` (tools/memfoot, `proc_pid_rusage`; under 1 ms for any number of pids). `footprint -p` reports only one process per call. WhisperKit's Core ML model shows as ~60 MB: the rest is held outside its process.

| Option | Model / size | Partials | Languages | Release → final (3 s clip, M5, through /ws) |
|---|---|---|---|---|
| `local_parakeet` | `mlx-community/parakeet-tdt-0.6b-v3`, 2.3 GB | re-transcribes the clip every 0.8 s | 25 European, detected (ro ✅) | 129 ms (engine ~100 ms warm) |
| `local_apple` | macOS 26 `SpeechAnalyzer` + `SpeechTranscriber`, system-managed | ✅ native volatile results (`.volatileResults, .fastResults`) | en, fr, de, es, it, pt, zh, ja, ko… (no ro) | 209 ms |
| `local_whisperkit` | `openai_whisper-large-v3-v20240930_turbo` Core ML, 1.5 GB | ❌ batch | ~100 (ro ✅ pinned or detected) | 596 ms |
| `local_moonshine` | Moonshine Voice `medium-streaming-en`, 412 MB | re-transcribes every 0.8 s | English only (catalogue: ar es de en ja ko vi uk zh tl) | 273 ms |

- **Parakeet** (`tools/localstt/server.py`): `from_pretrained(..., cache_dir=.models/parakeet)`, audio resampled 24→16 kHz (`resample_poly(2, 3)`), `model.generate(get_logmel(...))`. Tokens are subwords; a token with a leading space starts a word. The first run takes ~2.7 s (warmed at start).
- **Moonshine**: `download_model_from_info(..., include_word_timestamps=True)` returns `(path, arch)`; `Transcriber(path, arch, options={"word_timestamps": "true"})`; `transcribe_without_streaming(samples, 24000)` takes 24 kHz directly. Without the option the model loads but returns no words. Less accurate than the others on `say` clips ("over here" → "around").
- **Apple** (`tools/macstt/main.swift`, compiled once like mactts): word times come from the `audioTimeRange` attribute on the result's `AttributedString` runs. Without `.fastResults`, volatile results only arrive after the input ends. No TCC prompt for a CLI helper. `SpeechTranscriber.supportedLocales` has no Romanian; `DictationTranscriber` lists ro-RO, but its asset never installs ("transcription.ro asset unavailable after attempted download, final state: Not Installing", even after `AssetInventory.reserve`). The helper still falls back to DictationTranscriber for locales SpeechTranscriber lacks.
- **WhisperKit**: `whisperkit-cli serve --model-path … --word-timestamps --host 127.0.0.1 --port <free port>` (picked at launch; `WHISPERKIT_PORT` pins it) is OpenAI-compatible: multipart `POST /v1/audio/transcriptions`, `response_format=verbose_json`, `timestamp_granularities[]=word` → `words[{word,start,end}]` with a leading space. The first load compiles the model for the Neural Engine (a few minutes, once); later starts take ~1 s. Ready when it logs "Server started".

## Sources
- Anthropic: bundled `claude-api` skill (models, Haiku 5.5 / Opus 5.5 migration notes)
- OpenAI pricing: https://developers.openai.com/api/docs/pricing
- ElevenLabs models: https://elevenlabs.io/docs/overview/models
- ElevenLabs pricing: https://elevenlabs.io/pricing/api
- ElevenLabs realtime STT API: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
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
