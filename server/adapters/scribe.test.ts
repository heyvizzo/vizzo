import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarkName } from "../../shared/marks.ts";
import { buildScribeUrl, createOpenScribe, filterWords, type WsLike } from "./scribe.ts";

class FakeWs extends EventEmitter implements WsLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closeCalls = 0;
  constructor(public url: string, public headers: Record<string, string>) {
    super();
  }
  send(data: string) {
    if (this.readyState !== 1) throw new Error("send while not open");
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closeCalls++;
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", 1000, Buffer.from("")));
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  server(msg: Record<string, unknown>) {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
}

function setup(over: { fallbackMs?: number; finalTimeoutMs?: number } = {}) {
  const sockets: FakeWs[] = [];
  const marks: { name: MarkName; meta?: Record<string, unknown> }[] = [];
  const open = createOpenScribe({
    wsFactory: (url, headers) => {
      const s = new FakeWs(url, headers);
      sockets.push(s);
      return s;
    },
    apiKey: () => "test-key",
    ...over,
  });
  const mark = (name: MarkName, meta?: Record<string, unknown>) => marks.push({ name, meta });
  return { open, sockets, marks, mark };
}

/** Opens a stream with the socket open and session started. */
async function started(over?: { fallbackMs?: number; finalTimeoutMs?: number }) {
  const ctx = setup(over);
  const p = ctx.open({ mark: ctx.mark, keyterms: ["Opus"] });
  const ws = ctx.sockets[0]!;
  ws.open();
  const stt = await p;
  ws.server({ message_type: "session_started", session_id: "s1", config: {} });
  return { ...ctx, ws, stt };
}

const pcm = (ms: number) => Buffer.alloc((24000 * 2 * ms) / 1000, 1);
const audioChunks = (ws: FakeWs) => ws.sent.filter((m) => m.commit === false);
const timestamped = (text: string, start = 0) => ({
  message_type: "committed_transcript_with_timestamps", text, language_code: "en",
  words: text.split(" ").map((text, i) => ({ text, type: "word", start: start + i, end: start + i + 0.5 })),
});

afterEach(() => vi.useRealTimers());

describe("buildScribeUrl", () => {
  it("has the required params and repeated keyterms", () => {
    const u = new URL(buildScribeUrl(["Opus", "Vite", "x".repeat(21)]));
    expect(u.origin + u.pathname).toBe("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
    expect(u.searchParams.get("model_id")).toBe("scribe_v2_realtime");
    expect(u.searchParams.get("audio_format")).toBe("pcm_24000");
    expect(u.searchParams.get("commit_strategy")).toBe("manual");
    expect(u.searchParams.get("include_timestamps")).toBe("true");
    expect(u.searchParams.get("language_code")).toBeNull(); // auto-detect unless pinned
    expect(u.searchParams.getAll("keyterms")).toEqual(["Opus", "Vite"]);
    expect(new URL(buildScribeUrl([], "ro")).searchParams.get("language_code")).toBe("ro");
  });
});

describe("filterWords", () => {
  it("keeps only type=word and maps to {text,start,end}", () => {
    expect(
      filterWords([
        { text: "Hello", start: 0.1, end: 0.4, type: "word", logprob: -0.1 },
        { text: " ", start: 0.4, end: 0.45, type: "spacing" },
        { text: "(laughs)", start: 0.5, end: 0.9, type: "audio_event" },
        { text: "world", start: 0.5, end: 0.9, type: "word", speaker_id: "a" },
      ]),
    ).toEqual([
      { text: "Hello", start: 0.1, end: 0.4 },
      { text: "world", start: 0.5, end: 0.9 },
    ]);
    expect(filterWords(undefined)).toEqual([]);
  });
});

describe("openScribe", () => {
  it("sends the api key header and resolves on socket open", async () => {
    const ctx = setup();
    let resolved = false;
    const p = ctx.open({ mark: ctx.mark }).then((s) => ((resolved = true), s));
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(ctx.sockets[0]!.headers["xi-api-key"]).toBe("test-key");
    ctx.sockets[0]!.open();
    await p;
    expect(resolved).toBe(true);
  });

  it("rejects when the socket fails before open", async () => {
    const ctx = setup();
    const p = ctx.open({ mark: ctx.mark });
    ctx.sockets[0]!.emit("unexpected-response", {}, { statusCode: 401 });
    await expect(p).rejects.toThrow(/401/);
  });

  it("rejects without an API key", async () => {
    const open = createOpenScribe({ wsFactory: () => new FakeWs("", {}), apiKey: () => undefined });
    await expect(open({ mark: () => {} })).rejects.toThrow(/ELEVENLABS_API_KEY/);
  });

  it("buffers audio and commit until session_started, then flushes in order", async () => {
    const ctx = setup();
    const p = ctx.open({ mark: ctx.mark });
    const ws = ctx.sockets[0]!;
    ws.open();
    const stt = await p;
    for (let i = 0; i < 10; i++) stt.pushAudio(pcm(20)); // 200 ms
    stt.pushAudio(pcm(10)); // + 10 ms tail
    stt.commit();
    expect(ws.sent).toEqual([]);
    expect(stt.seconds).toBe(0);
    ws.server({ message_type: "session_started", session_id: "s", config: {} });
    const total = ws.sent.filter((m) => m.commit === false).reduce((n, m) => n + Buffer.from(String(m.audio_base_64), "base64").length, 0);
    expect(total).toBe(pcm(210).length);
    expect(stt.seconds).toBeCloseTo(0.21, 6);
    const last = ws.sent.at(-1)!;
    expect(last).toEqual({ message_type: "input_audio_chunk", audio_base_64: "", commit: true, sample_rate: 24000 });
    for (const m of ws.sent) expect(m.sample_rate).toBe(24000);
  });

  it("coalesces 20 ms pushes into >=100 ms messages and splits > 1 s pushes", async () => {
    const { ws, stt } = await started();
    for (let i = 0; i < 4; i++) stt.pushAudio(pcm(20));
    expect(audioChunks(ws)).toHaveLength(0);
    stt.pushAudio(pcm(20));
    expect(audioChunks(ws)).toHaveLength(1);
    stt.pushAudio(pcm(2500));
    const sizes = audioChunks(ws).slice(1).map((m) => Buffer.from(String(m.audio_base_64), "base64").length);
    for (const s of sizes) {
      expect(s).toBeLessThanOrEqual(48000);
      expect(s).toBeGreaterThanOrEqual(4800);
    }
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(pcm(2500).length);
  });

  it("marks stt.firstPartial once, on the first non-empty partial", async () => {
    const { ws, stt, marks } = await started();
    const seen: string[] = [];
    stt.onPartial((t) => seen.push(t));
    ws.server({ message_type: "partial_transcript", text: "" });
    ws.server({ message_type: "partial_transcript", text: "hel" });
    ws.server({ message_type: "partial_transcript", text: "hello" });
    expect(marks.filter((m) => m.name === "stt.firstPartial")).toEqual([{ name: "stt.firstPartial", meta: { text: "hel" } }]);
    expect(seen).toEqual(["", "hel", "hello"]);
  });

  it("resolves final() on the timestamped commit with filtered words", async () => {
    const { ws, stt, marks } = await started();
    stt.pushAudio(pcm(200));
    stt.commit();
    ws.server({ message_type: "committed_transcript", text: "Hello world." });
    ws.server({
      message_type: "committed_transcript_with_timestamps",
      text: "Hello world.",
      language_code: "en",
      words: [
        { text: "Hello", start: 0.1, end: 0.4, type: "word" },
        { text: " ", start: 0.4, end: 0.45, type: "spacing" },
        { text: "world.", start: 0.45, end: 0.9, type: "word" },
      ],
    });
    await expect(stt.final()).resolves.toEqual({
      text: "Hello world.",
      words: [
        { text: "Hello", start: 0.1, end: 0.4 },
        { text: "world.", start: 0.45, end: 0.9 },
      ],
      language: "en",
    });
    const fin = marks.filter((m) => m.name === "stt.final");
    expect(fin).toHaveLength(1);
    expect(fin[0]!.meta).toMatchObject({ timestamped: true, words: 2 });
    expect(fin[0]!.meta!.plainToTimestampedMs).toBeTypeOf("number");
  });

  it("falls back to the plain committed_transcript 3 s after commit", async () => {
    vi.useFakeTimers();
    const { ws, stt, marks } = await started();
    stt.pushAudio(pcm(200));
    stt.commit();
    ws.server({ message_type: "committed_transcript", text: "Hello." });
    let done = false;
    void stt.final().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(2900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await expect(stt.final()).resolves.toEqual({ text: "Hello.", words: [] });
    expect(marks.find((m) => m.name === "stt.final")!.meta).toMatchObject({ timestamped: false, words: 0, fallback: "timeout" });
    // a late timestamped message does not re-mark
    ws.server({ message_type: "committed_transcript_with_timestamps", text: "Hello.", words: [] });
    expect(marks.filter((m) => m.name === "stt.final")).toHaveLength(1);
  });

  it("keeps automatic commits and live partials together until release, including repeated segments", async () => {
    vi.useFakeTimers();
    const { ws, stt, marks } = await started();
    const seen: string[] = [];
    stt.onPartial((text) => seen.push(text));
    let done = false;
    void stt.final().then(() => { done = true; });
    ws.server({ message_type: "partial_transcript", text: "First" });
    ws.server({ message_type: "committed_transcript", text: "First part." });
    ws.server(timestamped("First part.", 1));
    ws.server({ message_type: "partial_transcript", text: "" });
    ws.server({ message_type: "partial_transcript", text: "First" });
    ws.server({ message_type: "committed_transcript", text: "First part." });
    ws.server(timestamped("First part.", 37));
    ws.server({ message_type: "partial_transcript", text: "Last" });
    await Promise.resolve();
    expect(done).toBe(false);
    expect(marks.some((m) => m.name === "stt.final")).toBe(false);
    expect(seen.at(-1)).toBe("First part. First part. Last");

    stt.commit();
    await vi.advanceTimersByTimeAsync(2500);
    expect(done).toBe(false); // earlier committed text isn't the release response
    ws.server({ message_type: "committed_transcript", text: "Last part." });
    ws.server(timestamped("Last part.", 74));
    await expect(stt.final()).resolves.toEqual({
      text: "First part. First part. Last part.", language: "en",
      words: [1, 37, 74].flatMap((start, i) => timestamped(i === 2 ? "Last part." : "First part.", start).words.map(({ type: _, ...w }) => w)),
    });
    expect(marks.filter((m) => m.name === "stt.final")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for the release segment when an earlier segment's timestamps arrive after release", async () => {
    const { ws, stt } = await started();
    ws.server({ message_type: "committed_transcript", text: "Earlier segment." });
    stt.commit();
    let done = false;
    void stt.final().then(() => { done = true; });
    ws.server({ message_type: "committed_transcript", text: "Final segment." });
    // Timestamp work can finish out of order; pair it with its plain text.
    ws.server(timestamped("Final segment.", 37));
    await Promise.resolve();
    expect(done).toBe(false);
    ws.server(timestamped("Earlier segment.", 1));
    await expect(stt.final()).resolves.toMatchObject({
      text: "Earlier segment. Final segment.",
      words: [{ text: "Earlier", start: 1 }, { text: "segment.", start: 2 }, { text: "Final", start: 37 }, { text: "segment.", start: 38 }],
    });
  });

  it("falls back with every segment and no incomplete word list when timestamps are missing", async () => {
    vi.useFakeTimers();
    const { ws, stt } = await started();
    ws.server({ message_type: "committed_transcript", text: "Earlier segment." });
    ws.server(timestamped("Earlier segment.", 1));
    stt.commit();
    ws.server({ message_type: "committed_transcript", text: "Final segment." });
    await vi.advanceTimersByTimeAsync(3000);
    await expect(stt.final()).resolves.toMatchObject({ text: "Earlier segment. Final segment.", words: [] });
  });

  it("does not fall back to only an earlier segment while the release response is pending", async () => {
    vi.useFakeTimers();
    const { ws, stt } = await started();
    ws.server({ message_type: "committed_transcript", text: "Earlier segment." });
    ws.server(timestamped("Earlier segment.", 1));
    ws.server({ message_type: "partial_transcript", text: "Final segment" });
    stt.commit();
    let done = false;
    void stt.final().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(3500);
    expect(done).toBe(false);
    ws.server(timestamped("Final segment.", 37));
    await expect(stt.final()).resolves.toMatchObject({ text: "Earlier segment. Final segment." });
  });

  it("rejects a missing final segment instead of silently losing its live partial", async () => {
    vi.useFakeTimers();
    for (const end of ["socket", "timeout"]) {
      const { ws, stt } = await started();
      ws.server({ message_type: "committed_transcript", text: "Earlier segment." });
      ws.server(timestamped("Earlier segment.", 1));
      ws.server({ message_type: "partial_transcript", text: "Do not lose this" });
      stt.commit();
      const rejected = expect(stt.final()).rejects.toThrow(/before final|no transcript/);
      if (end === "socket") ws.emit("close", 1006, Buffer.from(""));
      else await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
    }
  });

  it("an empty release segment or no-speech error preserves earlier committed speech", async () => {
    for (const empty of [
      { message_type: "committed_transcript_with_timestamps", text: "", words: [] },
      { message_type: "insufficient_audio_activity", error: "No speech detected" },
    ]) {
      const { ws, stt } = await started();
      ws.server({ message_type: "committed_transcript", text: "Keep this." });
      ws.server(timestamped("Keep this.", 1));
      stt.commit();
      ws.server(empty);
      await expect(stt.final()).resolves.toMatchObject({ text: "Keep this.", words: [{ text: "Keep", start: 1 }, { text: "this.", start: 2 }] });
    }
  });

  it("ignores partials after finalization and close", async () => {
    const { ws, stt } = await started();
    const seen: string[] = [];
    stt.onPartial((text) => seen.push(text));
    stt.commit();
    ws.server(timestamped("Finished."));
    await stt.final();
    const before = [...seen];
    ws.server({ message_type: "partial_transcript", text: "late tail" });
    expect(seen).toEqual(before);
    stt.close();
    ws.server({ message_type: "partial_transcript", text: "after close" });
    expect(seen).toEqual(before);
  });

  it("resolves immediately if the plain transcript arrives after the fallback deadline", async () => {
    vi.useFakeTimers();
    const { ws, stt } = await started();
    stt.commit();
    await vi.advanceTimersByTimeAsync(3500);
    ws.server({ message_type: "committed_transcript", text: "Late." });
    await expect(stt.final()).resolves.toEqual({ text: "Late.", words: [] });
  });

  it("insufficient_audio_activity resolves with empty text and records meta", async () => {
    const { ws, stt, marks } = await started();
    stt.commit();
    ws.server({ message_type: "insufficient_audio_activity", error: "No speech detected" });
    await expect(stt.final()).resolves.toEqual({ text: "", words: [] });
    expect(marks.find((m) => m.name === "stt.final")!.meta).toMatchObject({ timestamped: false, words: 0, error: "insufficient_audio_activity" });
  });

  it("other vendor errors reject final()", async () => {
    const { ws, stt, marks } = await started();
    stt.commit();
    ws.server({ message_type: "quota_exceeded", error: "Out of credits" });
    await expect(stt.final()).rejects.toThrow(/quota_exceeded: Out of credits/);
    expect(marks.some((m) => m.name === "stt.final")).toBe(false);
  });

  it("socket close before any transcript rejects final(); with plain text in hand it resolves", async () => {
    const a = await started();
    a.stt.commit();
    a.ws.emit("close", 1006, Buffer.from(""));
    await expect(a.stt.final()).rejects.toThrow(/closed \(1006\)/);

    const b = await started();
    b.stt.commit();
    b.ws.server({ message_type: "committed_transcript", text: "Hi." });
    b.ws.emit("close", 1000, Buffer.from(""));
    await expect(b.stt.final()).resolves.toEqual({ text: "Hi.", words: [] });
  });

  it("close() is idempotent, rejects a pending final, and drops later audio", async () => {
    const { ws, stt } = await started();
    stt.close();
    stt.close();
    expect(ws.closeCalls).toBe(1);
    await expect(stt.final()).rejects.toThrow(/closed before final/);
    expect(() => stt.pushAudio(pcm(200))).not.toThrow();
    expect(stt.seconds).toBe(0);
  });

  it("ignores audio after commit and a second commit", async () => {
    const { ws, stt } = await started();
    stt.pushAudio(pcm(100));
    stt.commit();
    stt.pushAudio(pcm(100));
    stt.commit();
    expect(ws.sent.filter((m) => m.commit === true)).toHaveLength(1);
    expect(stt.seconds).toBeCloseTo(0.1, 6);
  });
});
