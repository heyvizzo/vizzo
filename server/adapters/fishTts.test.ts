import { describe, expect, it } from "vitest";
import { createFishTts, OPENROUTER_SPEECH_URL } from "./fishTts.ts";

/** Fake OpenRouter speech endpoint: returns 44.1 kHz PCM16 (as OpenRouter does for drama-3), one chunk per request. */
function fakeFetch(status = 200) {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    if (status >= 400) return new Response("bad key", { status });
    // 0.1 s of silence at 44.1 kHz = 4410 samples = 8820 bytes; resampled to 24 kHz it is 2400 samples.
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(8820)); c.close(); } });
    return new Response(stream, { status: 200, headers: { "content-type": "audio/pcm;rate=44100;channels=1" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("Fish Audio Drama 3 adapter (via OpenRouter)", () => {
  it("one pcm request per sentence to OpenRouter, resampled 44.1 kHz → 24 kHz", async () => {
    const { f, calls } = fakeFetch();
    const marks: { name: string; meta?: Record<string, unknown> }[] = [];
    const tts = await createFishTts({ fetch: f, apiKey: "or-test", voice: "voice-abc" })({ mark: (name, meta) => marks.push({ name, meta }), voiceId: "", model: "fish_drama_3", segment: "answer" });
    let bytes = 0;
    tts.onAudio((b) => { bytes += b.length; });
    tts.pushText("Hello there. How are you?");
    await tts.done();

    expect(calls.map((c) => c.url)).toEqual([OPENROUTER_SPEECH_URL, OPENROUTER_SPEECH_URL]);
    expect(calls[0]!.headers.Authorization).toBe("Bearer or-test");
    expect(calls[0]!.body).toEqual({ model: "fish-audio/drama-3", input: "Hello there.", response_format: "pcm", voice: "voice-abc" });
    // Two sentences of 0.1 s each → about 0.2 s at 24 kHz = 9600 bytes (resampler carries fractions across chunks).
    expect(Math.abs(bytes - 9600)).toBeLessThanOrEqual(4);
    expect(marks[0]).toMatchObject({ name: "answer.ttsFirstByte", meta: { model: "fish-audio/drama-3", voice: "voice-abc" } });
    expect(tts.chars).toBe("Hello there. How are you?".length);
  });

  it("prepends the direction in brackets to every sentence", async () => {
    const { f, calls } = fakeFetch();
    const tts = await createFishTts({ fetch: f, apiKey: "k", direction: "calm, warm" })({ mark: () => {}, voiceId: "", model: "fish_drama_3", segment: "answer" });
    tts.pushText("One. Two.");
    await tts.done();
    expect(calls.map((c) => c.body.input)).toEqual(["[calm, warm] One.", "[calm, warm] Two."]);
  });

  it("style: direction and speed reach the request", async () => {
    const { f, calls } = fakeFetch();
    const style = { direction: "warm", speed: 1.5, volume: 0.5 };
    const tts = await createFishTts({ fetch: f, apiKey: "k", direction: "env-direction" })({ mark: () => {}, voiceId: "", model: "fish_drama_3", segment: "answer", style });
    tts.onAudio(() => {});
    tts.pushText("Hello there.");
    await tts.done();
    expect(calls[0]!.body.input).toBe("[warm] Hello there.");
    expect(calls[0]!.body.speed).toBe(1.5);
  });

  it("volume scales samples and clips at 16 bits", async () => {
    const loud = Buffer.alloc(8820);
    for (let i = 0; i + 1 < loud.length; i += 2) loud.writeInt16LE(i % 4 === 0 ? 30000 : -30000, i);
    const f = (async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(loud)); c.close(); } }), { status: 200, headers: { "content-type": "audio/pcm;rate=44100;channels=1" } })) as unknown as typeof fetch;
    const tts = await createFishTts({ fetch: f, apiKey: "k" })({ mark: () => {}, voiceId: "", model: "fish_drama_3", segment: "ack", style: { direction: "", speed: 1, volume: 2 } });
    let out = Buffer.alloc(0);
    tts.onAudio((b) => { out = Buffer.concat([out, b]); });
    tts.pushText("Loud.");
    await tts.done();
    const values = Array.from({ length: out.length / 2 }, (_, i) => out.readInt16LE(i * 2));
    expect(Math.max(...values)).toBe(32767); // 30000 × 2 clips
    expect(Math.min(...values)).toBe(-32768);
  });

  it("omits voice when none is set", async () => {
    const { f, calls } = fakeFetch();
    const prev = process.env.FISH_VOICE_ID;
    delete process.env.FISH_VOICE_ID;
    const tts = await createFishTts({ fetch: f, apiKey: "k" })({ mark: () => {}, voiceId: "", model: "fish_drama_3", segment: "ack" });
    tts.pushText("Okay.");
    await tts.done();
    expect(calls[0]!.body).not.toHaveProperty("voice");
    if (prev !== undefined) process.env.FISH_VOICE_ID = prev;
  });

  it("HTTP errors reject done(); a missing key fails at open", async () => {
    const { f } = fakeFetch(401);
    const tts = await createFishTts({ fetch: f, apiKey: "k" })({ mark: () => {}, voiceId: "", model: "fish_drama_3", segment: "ack" });
    tts.pushText("Hello.");
    await expect(tts.done()).rejects.toThrow(/Drama 3 TTS \(OpenRouter\) 401/);
    const prev = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    await expect(createFishTts({ fetch: f })({ mark: () => {}, voiceId: "", model: "fish_drama_3", segment: "ack" })).rejects.toThrow(/OPENROUTER_API_KEY/);
    if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev;
  });
});
