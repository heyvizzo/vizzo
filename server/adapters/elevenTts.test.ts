import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOpenTtsHttp,
  createOpenTtsWs,
  FLASH_CHUNK_SCHEDULE,
  KEEP_ALIVE_MS,
  Pcm16Carry,
  splitSentences,
  WordChunker,
  type FetchLike,
  type WsLike,
} from "./elevenTts.ts";
import type { OpenTtsOpts } from "./types.ts";

class FakeWs implements WsLike {
  static last: FakeWs;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed = false;
  private handlers = new Map<string, ((...a: any[]) => void)[]>();
  constructor(public url: string, public opts: { headers: Record<string, string> }) {
    FakeWs.last = this;
  }
  on(event: string, cb: (...a: any[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
  }
  // test helpers
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  server(msg: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
  serverClose(code = 1000, reason = "") {
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }
}

const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");

function setup(model: OpenTtsOpts["model"], segment: OpenTtsOpts["segment"] = "ack") {
  const marks: { name: string; meta?: Record<string, unknown> }[] = [];
  const opts: OpenTtsOpts = { mark: (name, meta) => marks.push({ name, meta }), voiceId: "VOICE", model, segment };
  const open = createOpenTtsWs({ WebSocket: FakeWs, apiKey: "KEY", log: () => {} });
  return { marks, opts, open };
}

async function openStream(model: OpenTtsOpts["model"], segment: OpenTtsOpts["segment"] = "ack") {
  const s = setup(model, segment);
  const p = s.open(s.opts);
  const ws = FakeWs.last;
  ws.open();
  const stream = await p;
  return { ...s, ws, stream };
}

afterEach(() => vi.useRealTimers());

describe("WordChunker", () => {
  it("holds partial words until whitespace", () => {
    const c = new WordChunker();
    expect(c.push("The hea")).toBe("The ");
    expect(c.push("der is stic")).toBe("header is ");
    expect(c.push("ky")).toBeNull();
    expect(c.push(". ")).toBe("sticky. ");
    expect(c.drain()).toBeNull();
    c.push("tail");
    expect(c.drain()).toBe("tail");
  });
});

describe("Pcm16Carry", () => {
  it("always emits even-length buffers and carries the odd byte", () => {
    const c = new Pcm16Carry();
    expect([...c.push(Buffer.from([1, 2, 3]))!]).toEqual([1, 2]);
    expect(c.push(Buffer.from([]))).toBeNull();
    expect([...c.push(Buffer.from([4, 5, 6, 7]))!]).toEqual([3, 4, 5, 6]);
    expect(c.pending).toBe(1);
    expect([...c.push(Buffer.from([9]))!]).toEqual([7, 9]);
    expect(c.pending).toBe(0);
  });
});

describe("splitSentences", () => {
  it("splits on terminators followed by whitespace, keeps the rest", () => {
    expect(splitSentences("Sure, one sec. The header is sticky! Why? Pi is 3.14 and")).toEqual({
      sentences: ["Sure, one sec.", "The header is sticky!", "Why?"],
      rest: "Pi is 3.14 and",
    });
    expect(splitSentences('He said "go." Then\nnew line')).toEqual({ sentences: ['He said "go."', "Then"], rest: "new line" });
    expect(splitSentences("No end yet.")).toEqual({ sentences: [], rest: "No end yet." });
  });
});

describe("openTts over WebSocket: eleven_flash_v2_5 (TTS stream-input)", () => {
  it("connects with auth + pcm_24000 and sends the documented message sequence", async () => {
    const { ws, stream } = await openStream("eleven_flash_v2_5");
    expect(ws.url).toBe(
      "wss://api.elevenlabs.io/v1/text-to-speech/VOICE/stream-input?model_id=eleven_flash_v2_5&output_format=pcm_24000&inactivity_timeout=180",
    );
    expect(ws.opts.headers["xi-api-key"]).toBe("KEY");
    stream.pushText("Sure, one");
    stream.pushText(" sec.");
    stream.flush();
    stream.pushText("ignored");
    expect(ws.sent).toEqual([
      { text: " ", voice_settings: expect.any(Object), generation_config: { chunk_length_schedule: FLASH_CHUNK_SCHEDULE } },
      { text: "Sure, " },
      { text: "one " },
      { text: "sec. " },
      { text: " ", flush: true },
      { text: "" },
    ]);
    expect(stream.chars).toBe("Sure, one sec.".length);
  });

  it("decodes audio, marks first byte once, carries odd bytes, resolves on isFinal", async () => {
    const { ws, stream, marks } = await openStream("eleven_flash_v2_5", "answer");
    const got: Buffer[] = [];
    stream.onAudio((b) => got.push(b));
    ws.server({ audio: b64([1, 2, 3]), alignment: null });
    ws.server({ audio: b64([4, 5, 6]), normalizedAlignment: null });
    ws.server({ audio: null, isFinal: true });
    await expect(stream.done()).resolves.toBeUndefined();
    expect(got.map((b) => [...b])).toEqual([[1, 2], [3, 4, 5, 6]]);
    expect(got.every((b) => b.length % 2 === 0)).toBe(true);
    expect(marks).toEqual([{ name: "answer.ttsFirstByte", meta: { model: "eleven_flash_v2_5", bytes: 3 } }]);
    expect(ws.closed).toBe(true);
  });

  it("buffers audio until a listener is attached", async () => {
    const { ws, stream } = await openStream("eleven_flash_v2_5");
    ws.server({ audio: b64([1, 2]) });
    const got: number[][] = [];
    stream.onAudio((b) => got.push([...b]));
    expect(got).toEqual([[1, 2]]);
  });

  it("resolves done on plain socket close", async () => {
    const { ws, stream } = await openStream("eleven_flash_v2_5");
    stream.flush();
    ws.serverClose(1000);
    await expect(stream.done()).resolves.toBeUndefined();
  });

  it("rejects done on a vendor error message", async () => {
    const { ws, stream } = await openStream("eleven_flash_v2_5");
    ws.server({ message: "bad voice", error: "invalid_request", code: 1008 });
    await expect(stream.done()).rejects.toThrow(/invalid_request.*bad voice/);
  });

  it("rejects done on an error close code without a final message", async () => {
    const { ws, stream } = await openStream("eleven_flash_v2_5");
    ws.serverClose(1008, "policy");
    await expect(stream.done()).rejects.toThrow(/1008/);
  });

  it("rejects open on HTTP upgrade failure", async () => {
    const s = setup("eleven_flash_v2_5");
    const p = s.open(s.opts);
    FakeWs.last.emit("unexpected-response", {}, { statusCode: 401 });
    await expect(p).rejects.toThrow(/401/);
  });

  it("close() is idempotent and resolves done", async () => {
    const { ws, stream } = await openStream("eleven_flash_v2_5");
    stream.close();
    stream.close();
    await expect(stream.done()).resolves.toBeUndefined();
    expect(ws.closed).toBe(true);
  });

  it("sends keep-alive only while idle and not flushed", async () => {
    vi.useFakeTimers();
    const { ws, stream } = await openStream("eleven_flash_v2_5");
    vi.advanceTimersByTime(KEEP_ALIVE_MS + 1);
    expect(ws.sent.at(-1)).toEqual({ text: " " });
    stream.flush();
    const n = ws.sent.length;
    vi.advanceTimersByTime(KEEP_ALIVE_MS * 3);
    expect(ws.sent.length).toBe(n);
  });
});

describe("openTts over WebSocket: eleven_v4_turbo (Text-to-Dialogue)", () => {
  it("uses the TTD endpoint and protocol", async () => {
    const { ws, stream } = await openStream("eleven_v4_turbo");
    expect(ws.url).toBe("wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input?model_id=eleven_v4_turbo&output_format=pcm_24000");
    expect(ws.opts.headers["xi-api-key"]).toBe("KEY");
    stream.pushText("One sec, ");
    stream.pushText("looking");
    stream.flush();
    expect(ws.sent).toEqual([
      { voices: ["VOICE"], voice_settings: { stability: 0.5 } },
      { inputs: [{ text: "One sec, ", voice_id: "VOICE" }] },
      { inputs: [{ text: "looking", voice_id: "VOICE" }] },
      { flush: true },
      { close_socket: true },
    ]);
    expect(stream.chars).toBe(16);
  });

  it("marks ack first byte and resolves on snake_case is_final", async () => {
    const { ws, stream, marks } = await openStream("eleven_v4_turbo", "ack");
    const got: Buffer[] = [];
    stream.onAudio((b) => got.push(b));
    ws.server({ audio: b64([1, 2, 3, 4, 5]), alignment: null, normalized_alignment: null });
    ws.server({ is_final_audio_for_turn: true });
    ws.server({ audio: b64([6]) });
    ws.server({ is_final: true });
    await stream.done();
    expect(got.map((b) => [...b])).toEqual([[1, 2, 3, 4], [5, 6]]);
    expect(marks.map((m) => m.name)).toEqual(["ack.ttsFirstByte"]);
    expect(marks[0]!.meta).toEqual({ model: "eleven_v4_turbo", bytes: 5 });
  });

  it("sends keep_alive when idle (20 s TTD limit)", async () => {
    vi.useFakeTimers();
    const { ws, stream } = await openStream("eleven_v4_turbo");
    vi.advanceTimersByTime(KEEP_ALIVE_MS - 1);
    stream.pushText("hi ");
    vi.advanceTimersByTime(KEEP_ALIVE_MS - 1);
    expect(ws.sent.some((m) => "keep_alive" in m)).toBe(false);
    vi.advanceTimersByTime(2);
    expect(ws.sent.at(-1)).toEqual({ keep_alive: true });
  });

  it("rejects on a TTD error message", async () => {
    const { ws, stream } = await openStream("eleven_v4_turbo");
    ws.server({ message: "no", error: "authentication_required", code: 1008, param: null });
    await expect(stream.done()).rejects.toThrow(/authentication_required/);
  });
});

describe("openTtsHttp (per-sentence fallback)", () => {
  function fakeFetch(chunksPerCall: number[][][]) {
    const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
    const fetch: FetchLike = async (url, init) => {
      const chunks = chunksPerCall[calls.length] ?? [];
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          for (const ch of chunks) c.enqueue(new Uint8Array(ch));
          c.close();
        },
      });
      return { ok: true, status: 200, body, text: async () => "" };
    };
    return { fetch, calls };
  }

  it("requests one sentence at a time and streams even-length PCM", async () => {
    const { fetch, calls } = fakeFetch([[[1, 2, 3], [4]], [[5, 6, 7]]]);
    const marks: string[] = [];
    const open = createOpenTtsHttp({ fetch, apiKey: "KEY", log: () => {} });
    const stream = await open({ mark: (n) => marks.push(n), voiceId: "VOICE", model: "eleven_flash_v2_5", segment: "answer" });
    const got: number[][] = [];
    stream.onAudio((b) => got.push([...b]));
    stream.pushText("The header is ");
    stream.pushText("sticky. It stays");
    stream.pushText(" visible");
    stream.flush();
    await stream.done();
    expect(calls.map((c) => c.body.text)).toEqual(["The header is sticky.", "It stays visible"]);
    expect(calls[0]!.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/VOICE/stream?output_format=pcm_24000");
    expect(calls[0]!.headers["xi-api-key"]).toBe("KEY");
    expect(calls[0]!.body.model_id).toBe("eleven_flash_v2_5");
    expect(calls[1]!.body.previous_text).toBe("The header is sticky.");
    expect(got).toEqual([[1, 2], [3, 4], [5, 6]]);
    expect(marks).toEqual(["answer.ttsFirstByte"]);
    expect(stream.chars).toBe("The header is sticky. It stays visible".length);
  });

  it("rejects done on a non-2xx response", async () => {
    const fetch: FetchLike = async () => ({ ok: false, status: 422, body: null, text: async () => "bad" });
    const stream = await createOpenTtsHttp({ fetch, apiKey: "K", log: () => {} })({
      mark: () => {}, voiceId: "V", model: "eleven_flash_v2_5", segment: "ack",
    });
    stream.pushText("Hi.");
    stream.flush();
    await expect(stream.done()).rejects.toThrow(/422/);
  });

  it("resolves immediately on flush with no text", async () => {
    const { fetch, calls } = fakeFetch([]);
    const stream = await createOpenTtsHttp({ fetch, apiKey: "K", log: () => {} })({
      mark: () => {}, voiceId: "V", model: "eleven_flash_v2_5", segment: "ack",
    });
    stream.flush();
    await stream.done();
    expect(calls).toEqual([]);
  });
});
