# Vendor API notes

Checked 2026-10-13. **✅ = confirmed against the vendor's own docs. ⚠️ = not yet confirmed: task T1 (API verification) must check these against live docs before adapters are built, then update this file.**

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

- URL: `wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1` ✅
- Auth: `Authorization: Bearer $OPENAI_API_KEY` ✅. Whether an `OpenAI-Beta` header is still needed isn't stated ⚠️ (believed not needed for GA).
- `session.update` minimal shape ✅: `{"type":"session.update","session":{"type":"realtime","instructions":"..."}}`
- ⚠️ To confirm in the client/server events reference:
  - session fields for input/output audio format (PCM16 24 kHz), voice, `turn_detection: null` (push-to-talk), `tools`, `tool_choice`
  - client events: `input_audio_buffer.append` / `.commit` / `.clear`, `conversation.item.create` (text context item, and `function_call_output`), `response.create`
  - server event names for output audio delta, output transcript delta, function-call arguments done, `response.done`, and where `usage` appears
- Don't confuse this with the separate "GPT-Live" WebSocket at `wss://api.openai.com/v1/live/sessions`, which has different event names (`session.output_audio.delta`, …). We use `/v1/realtime`.

## ElevenLabs Scribe v2 Realtime (STT) ✅

- URL: `wss://api.elevenlabs.io/v1/speech-to-text/realtime` (regional: `api.us.elevenlabs.io`, EU/IN/SG residency hosts)
- Auth: header `xi-api-key`, or `?token=` with a single-use token (`/docs/api-reference/tokens/create`)
- Query params we use: `model_id=scribe_v2_realtime`, `audio_format=pcm_24000`, `commit_strategy=manual`, `include_timestamps=true`, optional `language_code=en`, `keyterms` (≤50, ≤20 chars each), `keepalive_interval_ms`
- Client message:
  ```json
  {"message_type":"input_audio_chunk","audio_base_64":"...","commit":false,"sample_rate":24000}
  ```
  `previous_text` is allowed **only on the first chunk**. To commit on release, send a chunk with `"commit": true` (it can be an empty or final chunk ⚠️: confirm an empty `audio_base_64` is accepted).
- Server messages: `session_started`, `partial_transcript {text}`, `committed_transcript {text}`, `committed_transcript_with_timestamps {text, language_code, words[]}`, plus errors (`commit_throttled`, `insufficient_audio_activity`, `chunk_size_exceeded`, …).
- `words[]` items: `{text, start, end, type: "word"|"spacing", speaker_id?, logprob?, characters?}`. `start`/`end` are **seconds from the start of the session's audio**. Filter to `type === "word"`.
- ⚠️ Inferred, not stated: `include_timestamps=true` is what produces `committed_transcript_with_timestamps`, and it may arrive **alongside** plain `committed_transcript`. Handle both, and resolve `final()` on the timestamped one, with a fallback timeout.
- ⚠️ Whether `start`/`end` reset per commit or keep counting for the whole session. Matters if a session is reused across turns. Simplest choice: **one Scribe session per turn**, opened at `press`, and record the setup time.
- Timestamps come only with **committed** segments. Partials are text only.

## ElevenLabs TTS (Eleven v4 Turbo)

- Model IDs ✅: `eleven_v4_turbo` (~100 ms model latency, 90+ languages, audio tags, recommended for Agents), `eleven_flash_v2_5` (~75 ms, 32 languages, doesn't normalize numbers by default), `eleven_v3_conversational` (~280 ms).
- One third-party benchmark (via Cartesia, a competitor) reported >1 s P90 time-to-first-audio for ElevenLabs. Measure it ourselves.
- ⚠️ All to confirm (the docs page wasn't fetched): the WebSocket streaming endpoint `wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input?model_id=…&output_format=pcm_24000`, auth via `xi-api-key` header or first-message field, message shapes (initial `{"text":" "}` with voice settings and `generation_config.chunk_length_schedule`, text chunks, `flush: true`, closing `{"text":""}`), server messages (`{audio: base64, isFinal, alignment}`), and **whether `eleven_v4_turbo` is supported on the stream-input WebSocket**. Fallback if not: HTTP streaming `POST /v1/text-to-speech/{voice_id}/stream?output_format=pcm_24000`, one request per sentence.
- Also check the multi-context WebSocket (if available) so the ack and answer segments can share one socket.

## Sources
- Anthropic: bundled `claude-api` skill (models, Haiku 5.5 / Opus 5.5 migration notes)
- OpenAI pricing: https://developers.openai.com/api/docs/pricing
- OpenAI Realtime WS guide: https://developers.openai.com/api/docs/guides/realtime-websocket
- OpenAI realtime transcription guide: https://developers.openai.com/api/docs/guides/realtime-transcription
- ElevenLabs models: https://elevenlabs.io/docs/overview/models
- ElevenLabs pricing: https://elevenlabs.io/pricing/api
- ElevenLabs realtime STT API: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
- ElevenLabs TTS stream-input (to verify): https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input
