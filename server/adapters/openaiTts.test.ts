import { describe, expect, it } from "vitest";
import { createOpenAiTts, OPENAI_TTS_URL } from "./openaiTts.ts";

/** Fake fetch: per request, streams `chunks` (Buffers) with delays; records requests. */
function fakeFetch(plan: (body: { input: string }) => { status?: number; chunks: Buffer[]; delayMs: number }) {
  const calls: { url: string; body: Record<string, unknown>; auth: string }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body, auth: String((init.headers as Record<string, string>).Authorization) });
    const p = plan(body);
    if (p.status && p.status >= 400) return new Response("bad voice", { status: p.status });
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        for (const ch of p.chunks) { await new Promise((r) => setTimeout(r, p.delayMs)); c.enqueue(new Uint8Array(ch)); }
        c.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("OpenAI tts-1 adapter", () => {
  it("one pcm request per sentence; audio delivered in sentence order even when the second finishes first", async () => {
    // Sentence 1 is slow (3 chunks of 1s), sentence 2 fast (2s) → output must still be 1,1,1,2,2.
    const { f, calls } = fakeFetch(({ input }) => input.startsWith("First")
      ? { chunks: [Buffer.alloc(4, 1), Buffer.alloc(4, 1), Buffer.alloc(4, 1)], delayMs: 25 }
      : { chunks: [Buffer.alloc(4, 2), Buffer.alloc(4, 2)], delayMs: 1 });
    const marks: { name: string; meta?: Record<string, unknown> }[] = [];
    const tts = await createOpenAiTts({ fetch: f, apiKey: "sk-test", voice: "nova" })({ mark: (name, meta) => marks.push({ name, meta }), voiceId: "", model: "openai_tts_1", segment: "answer" });
    const out: number[] = [];
    tts.onAudio((b) => out.push(...b));
    tts.pushText("First sentence here. ");
    tts.pushText("Second one");
    tts.flush();
    await tts.done();
    expect(out).toEqual([...Array(12).fill(1), ...Array(8).fill(2)]);
    expect(calls.map((c) => c.body)).toEqual([
      { model: "tts-1", input: "First sentence here.", voice: "nova", response_format: "pcm" },
      { model: "tts-1", input: "Second one", voice: "nova", response_format: "pcm" },
    ]);
    expect(calls[0]!.url).toBe(OPENAI_TTS_URL);
    expect(calls[0]!.auth).toBe("Bearer sk-test");
    expect(marks).toEqual([{ name: "answer.ttsFirstByte", meta: expect.objectContaining({ model: "tts-1", voice: "nova" }) }]);
    expect(tts.chars).toBe("First sentence here. Second one".length);
  });

  it("keeps every chunk even-length (odd byte carried to the next chunk of the same response)", async () => {
    const { f } = fakeFetch(() => ({ chunks: [Buffer.from([1, 2, 3]), Buffer.from([4, 5, 6])], delayMs: 1 }));
    const tts = await createOpenAiTts({ fetch: f, apiKey: "k" })({ mark: () => {}, voiceId: "", model: "openai_tts_1", segment: "ack" });
    const chunks: Buffer[] = [];
    tts.onAudio((b) => chunks.push(b));
    tts.pushText("Hi.");
    tts.flush();
    await tts.done();
    expect(chunks.every((c) => c.length % 2 === 0)).toBe(true);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
  });

  it("HTTP errors reject done(); a missing key fails at open", async () => {
    const { f } = fakeFetch(() => ({ status: 400, chunks: [], delayMs: 0 }));
    const tts = await createOpenAiTts({ fetch: f, apiKey: "k" })({ mark: () => {}, voiceId: "", model: "openai_tts_1", segment: "ack" });
    tts.pushText("Hello.");
    await expect(tts.done()).rejects.toThrow(/OpenAI TTS 400/);
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    await expect(createOpenAiTts({ fetch: f })({ mark: () => {}, voiceId: "", model: "openai_tts_1", segment: "ack" })).rejects.toThrow(/OPENAI_API_KEY/);
    if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
  });
});
