import { describe, expect, it } from "vitest";
import { createOpenRouterStt, OPENROUTER_STT_URL, pcmToWav, WHISPER_MODEL } from "./openRouterStt.ts";

/** Fake fetch that answers with a verbose_json transcript and records the request body. */
function fakeFetch(reply: unknown, status = 200) {
  const calls: { url: string; body: Record<string, unknown>; auth: string }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).Authorization) });
    return status >= 400 ? new Response("nope", { status }) : new Response(JSON.stringify(reply), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const pcm = (seconds: number) => Buffer.alloc(Math.round(24000 * 2 * seconds));

describe("OpenRouter Whisper STT adapter", () => {
  it("sends one WAV on commit with word timestamps, and maps the words", async () => {
    const { f, calls } = fakeFetch({ text: " Move this here. ", language: "en", words: [{ word: " Move", start: 0.1, end: 0.4 }, { word: "this", start: 0.5, end: 0.7 }] });
    const s = await createOpenRouterStt({ fetch: f, apiKey: "or-test" })({ mark: () => {}, language: "en" });
    s.pushAudio(pcm(1));
    s.pushAudio(pcm(1));
    s.commit();
    const r = await s.final();
    expect(r).toEqual({ text: "Move this here.", words: [{ text: "Move", start: 0.1, end: 0.4 }, { text: "this", start: 0.5, end: 0.7 }], language: "en" });
    expect(s.seconds).toBeCloseTo(2, 5);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(OPENROUTER_STT_URL);
    expect(calls[0]!.auth).toBe("Bearer or-test");
    expect(calls[0]!.body).toMatchObject({ model: WHISPER_MODEL, response_format: "verbose_json", timestamp_granularities: ["word"], language: "en", input_audio: { format: "wav" } });
    const wav = Buffer.from(String((calls[0]!.body.input_audio as { data: string }).data), "base64");
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.length).toBe(44 + 2 * 48000);
  });

  it("the chosen option picks the OpenRouter model", async () => {
    const { f, calls } = fakeFetch({ text: "ok", words: [] });
    const open = createOpenRouterStt({ fetch: f, apiKey: "k" });
    const s = await open({ mark: () => {}, model: "openrouter_nemotron_asr" });
    s.pushAudio(pcm(0.5));
    s.commit();
    await s.final();
    const s2 = await open({ mark: () => {}, model: "openrouter_fish_transcribe_1" });
    s2.pushAudio(pcm(0.5));
    s2.commit();
    await s2.final();
    expect(calls.map((c) => c.body.model)).toEqual(["nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b", "fish-audio/transcribe-1"]);
  });

  it("no audio resolves empty without a request; audio after commit is ignored", async () => {
    const { f, calls } = fakeFetch({ text: "should not be used" });
    const s = await createOpenRouterStt({ fetch: f, apiKey: "k" })({ mark: () => {} });
    s.commit();
    expect(await s.final()).toEqual({ text: "", words: [] });
    expect(calls).toHaveLength(0);
  });

  it("HTTP errors reject final(); a missing key fails at open", async () => {
    const { f } = fakeFetch({}, 502);
    const s = await createOpenRouterStt({ fetch: f, apiKey: "k" })({ mark: () => {} });
    s.pushAudio(pcm(0.5));
    s.commit();
    await expect(s.final()).rejects.toThrow(/OpenRouter STT 502/);
    const prev = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    await expect(createOpenRouterStt({ fetch: f })({ mark: () => {} })).rejects.toThrow(/OPENROUTER_API_KEY/);
    if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev;
  });

  it("pcmToWav writes a 44-byte header for 16-bit mono at the given rate", () => {
    const w = pcmToWav(Buffer.alloc(4), 16000);
    expect(w.readUInt32LE(24)).toBe(16000);
    expect(w.readUInt32LE(40)).toBe(4);
  });
});
