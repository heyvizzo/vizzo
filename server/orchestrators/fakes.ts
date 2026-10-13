// Fake adapters with plausible timing and the same marks as the real ones. Used by the orchestrator
// unit tests and by `npm run smoke:e2e -- --fake` (exercises the whole server path without keys).
import type { GenerateFillers,
  OpenRealtime, OpenScribe, OpenTts, RealtimeSession, RealtimeUsage, RouteWithHaiku, SolveWithOpus, SttStream, ToolCall, TtsStream,
} from "../adapters/types.ts";
import type { Mark } from "../clock.ts";
import type { RouteIntent, Word } from "../../shared/protocol.ts";
import type { OrchestratorDeps } from "./types.ts";

export interface FakeTiming {
  /** Socket open delay for every adapter. */
  openMs: number;
  /** Commit → Scribe final. */
  sttFinalMs: number;
  /** Request → first token (Realtime, Haiku). */
  llmFirstMs: number;
  /** Request → first token (Opus); spoken line follows after the same again. */
  opusFirstMs: number;
  /** flush → first TTS audio. */
  ttsFirstMs: number;
  /** Gap between audio chunks. */
  chunkMs: number;
}

export const FAST_TIMING: FakeTiming = { openMs: 2, sttFinalMs: 5, llmFirstMs: 3, opusFirstMs: 5, ttsFirstMs: 3, chunkMs: 1 };
export const REALISTIC_TIMING: FakeTiming = { openMs: 120, sttFinalMs: 180, llmFirstMs: 250, opusFirstMs: 900, ttsFirstMs: 150, chunkMs: 20 };

export interface FakeScenario {
  /** Realtime: the model calls ask_opus (otherwise it answers directly). Haiku (auto mode): delegate. */
  delegate: boolean;
  transcript: string;
  words: Word[];
  /** Throw from this adapter (on open, unless noted). */
  failIn?: "scribe" | "realtime" | "tts" | "haiku" | "opus" | "realtime-response";
  /** Scribe never produces a final (tests the hybrid timeout path). */
  scribeHangs?: boolean;
  /** Router / Realtime decision (default question, 10 s). "clarify": asks a follow-up instead of delegating. */
  intent?: "question" | "task" | "clarify";
  estimateS?: number;
  /** Lines generateFillers returns (default two lines). */
  fillerLines?: string[];
}

export const DEFAULT_SCENARIO: FakeScenario = {
  delegate: true,
  transcript: "Why is this section built with a grid?",
  words: [
    { text: "Why", start: 0.1, end: 0.25 }, { text: "is", start: 0.25, end: 0.35 }, { text: "this", start: 0.35, end: 0.55 },
    { text: "section", start: 0.6, end: 0.95 }, { text: "built", start: 1.0, end: 1.2 }, { text: "with", start: 1.2, end: 1.3 },
    { text: "a", start: 1.3, end: 1.35 }, { text: "grid?", start: 1.35, end: 1.7 },
  ],
};

export const SPOKEN_LINE = "The grid keeps the three feature cards aligned in equal columns at every width.";
export const ACK = "Sure, checking that grid now.";
export const CLARIFY = "Which section do you mean, the features or the pricing?";
export const FILLER_LINES = ["I'm opening the stylesheet for that grid.", "Now checking the design notes."];
export const DIRECT_ANSWER = "Yes, I can hear you.";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** `n` 20 ms chunks of a quiet 440 Hz tone, PCM16 24 kHz. */
function tone(n: number): Buffer[] {
  const out: Buffer[] = [];
  for (let c = 0; c < n; c++) {
    const b = Buffer.alloc(960);
    for (let i = 0; i < 480; i++) b.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 440 * (c * 480 + i)) / 24000)), i * 2);
    out.push(b);
  }
  return out;
}

export interface FakeLog {
  opened: string[]; closed: string[];
  sentToolResults: { callId: string; output: string; respond?: false }[];
  contexts: (string | undefined)[];
  /** Realtime speak() calls and cancelResponse() count. */
  spoken: { text: string; kind: "filler" | "notice" }[];
  cancels: number;
}

export function createFakeDeps(t: FakeTiming = FAST_TIMING, sc: FakeScenario = DEFAULT_SCENARIO): OrchestratorDeps & { log: FakeLog } {
  const log: FakeLog = { opened: [], closed: [], sentToolResults: [], contexts: [], spoken: [], cancels: 0 };
  const intent = sc.intent ?? "question";
  const estimateS = sc.estimateS ?? 10;
  let seq = 0;

  const openScribe: OpenScribe = async ({ mark }) => {
    await wait(t.openMs);
    if (sc.failIn === "scribe") throw new Error("fake scribe: connect failed");
    const id = `scribe#${++seq}`;
    log.opened.push(id);
    let bytes = 0;
    let partial: ((s: string) => void) | null = null;
    let partialSent = false;
    let closed = false;
    let resolveFinal!: (v: { text: string; words: Word[] }) => void;
    let rejectFinal!: (e: Error) => void;
    const finalP = new Promise<{ text: string; words: Word[] }>((res, rej) => { resolveFinal = res; rejectFinal = rej; });
    finalP.catch(() => {});
    const s: SttStream = {
      pushAudio(b) {
        if (closed) return;
        bytes += b.length;
        if (!partialSent && bytes > 48000 * 0.3 && partial) {
          partialSent = true;
          mark("stt.firstPartial");
          partial(sc.transcript.split(" ").slice(0, 2).join(" "));
        }
      },
      commit() {
        if (sc.scribeHangs) return;
        setTimeout(() => {
          if (closed) return;
          mark("stt.final", { words: sc.words.length, timestamped: true });
          resolveFinal({ text: sc.transcript, words: sc.words });
        }, t.sttFinalMs);
      },
      onPartial(cb) { partial = cb; },
      final: () => finalP,
      close() {
        if (closed) return;
        closed = true;
        log.closed.push(id);
        rejectFinal(new Error("scribe: closed before final"));
      },
      get seconds() { return bytes / 48000; },
    };
    return s;
  };

  const openTts: OpenTts = async ({ mark, segment }) => {
    await wait(t.openMs);
    if (sc.failIn === "tts") throw new Error("fake tts: connect failed");
    const id = `tts:${segment}#${++seq}`;
    log.opened.push(id);
    let chars = 0;
    let closed = false;
    const cbs: ((b: Buffer) => void)[] = [];
    let resolveDone!: () => void;
    const doneP = new Promise<void>((r) => (resolveDone = r));
    const shut = () => { if (!closed) { closed = true; log.closed.push(id); resolveDone(); } };
    const s: TtsStream = {
      pushText(d) { if (!closed) chars += d.length; },
      flush() {
        void (async () => {
          await wait(t.ttsFirstMs);
          let first = true;
          for (const b of tone(5)) {
            if (closed) return;
            if (first) { first = false; mark(segment === "ack" ? "ack.ttsFirstByte" : "answer.ttsFirstByte", { fake: true }); }
            for (const cb of cbs) cb(b);
            await wait(t.chunkMs);
          }
          shut();
        })();
      },
      onAudio(cb) { cbs.push(cb); },
      done: () => doneP,
      close: shut,
      get chars() { return chars; },
    };
    return s;
  };

  const openRealtime: OpenRealtime = async ({ mark: initialMark }) => {
    await wait(t.openMs);
    if (sc.failIn === "realtime") throw new Error("fake realtime: connect failed");
    const id = `realtime#${++seq}`;
    log.opened.push(id);
    let mark: Mark = initialMark;
    let closed = false;
    type Seg = "ack" | "filler" | "answer" | "notice";
    let segment: Seg = "ack";
    let active: { seg: Seg; cancelled: boolean } | null = null;
    const queue: { seg: Seg; text?: string; done?: () => void }[] = [];
    let waiters: { res: () => void; rej: (e: Error) => void }[] = [];
    let marked = { first: false, ack: false, answer: false };
    const audioCbs: ((b: Buffer) => void)[] = [];
    const textCbs: ((d: string) => void)[] = [];
    const toolCbs: ((c: ToolCall) => void)[] = [];
    const errCbs: ((e: Error) => void)[] = [];
    const usage: RealtimeUsage = {
      responses: [],
      totals: { inputTokens: 0, outputTokens: 0, inputText: 0, inputAudio: 0, cachedText: 0, cachedAudio: 0, cached: 0, outputText: 0, outputAudio: 0 },
    };
    let audioBytes = 0;
    const marks = (seg: Seg) => seg === "ack" || seg === "answer";
    const pendingMain = () => (active && marks(active.seg) && !active.cancelled) || queue.some((q) => marks(q.seg));

    const respond = (seg: Seg, text?: string, done?: () => void) => {
      if (active) { queue.push({ seg, text, done }); return; }
      const me = { seg, cancelled: false };
      active = me;
      segment = seg;
      void (async () => {
        await wait(t.llmFirstMs);
        if (closed) return;
        if (sc.failIn === "realtime-response" && marks(seg)) {
          for (const cb of errCbs) cb(new Error("fake realtime: server_error"));
          return;
        }
        const say = async (line: string) => {
          for (const [i, b] of tone(5).entries()) {
            if (closed || me.cancelled) return;
            if (marks(seg) && !marked.first) { marked.first = true; mark("llm.firstToken"); }
            if (seg === "ack" && !marked.ack) { marked.ack = true; mark("ack.ttsFirstByte"); }
            if (seg === "answer" && !marked.answer) { marked.answer = true; mark("answer.ttsFirstByte"); }
            if (i === 0) for (const cb of textCbs) cb(line);
            for (const cb of audioCbs) cb(b);
            await wait(t.chunkMs);
          }
        };
        const delegates = sc.delegate && intent !== "clarify";
        if (seg === "ack") await say(delegates ? ACK : intent === "clarify" ? CLARIFY : DIRECT_ANSWER);
        else if (seg === "answer") await say(SPOKEN_LINE);
        else await say(text ?? "");
        if (closed) return;
        if (seg === "ack" && delegates && !me.cancelled) {
          const callId = `call_${seq}`;
          mark("llm.toolCall", { name: "ask_opus" });
          for (const cb of toolCbs) cb({ callId, name: "ask_opus", args: { intent, estimated_seconds: estimateS, question: "Why is the features section a CSS grid?" } });
        }
        if (marks(seg)) {
          const resp = { input_tokens: 100, output_tokens: 50, input_token_details: { text_tokens: 60, audio_tokens: 40, cached_tokens: 20, cached_tokens_details: { text_tokens: 20, audio_tokens: 0 } }, output_token_details: { text_tokens: 10, audio_tokens: 40 } };
          usage.responses.push(resp);
          const u = usage.totals;
          u.inputTokens += 100; u.outputTokens += 50; u.inputText += 60; u.inputAudio += 40; u.cached += 20; u.cachedText += 20;
          u.outputText += 10; u.outputAudio += 40;
        }
        active = null;
        done?.();
        const next = queue.shift();
        if (next) respond(next.seg, next.text, next.done);
        if (!pendingMain()) { const w = waiters; waiters = []; for (const x of w) x.res(); }
      })();
    };

    const s: RealtimeSession = {
      beginTurn() {
        marked = { first: false, ack: false, answer: false }; segment = "ack"; audioBytes = 0;
        if (active) active.cancelled = true; // stale: its audio stops
      },
      setMark(m) { mark = m; },
      pushAudio(b) { audioBytes += b.length; },
      commitAndRespond(extra) {
        log.contexts.push(extra);
        mark("llm.request");
        respond("ack");
      },
      onAudio(cb) { audioCbs.push(cb); },
      onText(cb) { textCbs.push(cb); },
      onToolCall(cb) { toolCbs.push(cb); },
      onError(cb) { errCbs.push(cb); },
      sendToolResult(callId, output, opts) {
        if (opts?.respond === false) { log.sentToolResults.push({ callId, output, respond: false }); return; }
        log.sentToolResults.push({ callId, output });
        respond("answer");
      },
      speak(text, kind) {
        log.spoken.push({ text, kind });
        return new Promise<void>((res) => respond(kind, text, res));
      },
      cancelResponse() {
        log.cancels++;
        if (active) active.cancelled = true;
        for (let i = queue.length - 1; i >= 0; i--) if (marks(queue[i]!.seg)) queue.splice(i, 1);
      },
      responseDone() {
        if (closed) return Promise.reject(new Error("fake realtime: closed"));
        if (!pendingMain()) return Promise.resolve();
        return new Promise((res, rej) => waiters.push({ res, rej }));
      },
      get currentSegment() { return segment; },
      get usage() { return usage; },
      close() {
        if (closed) return;
        closed = true;
        log.closed.push(id);
        const w = waiters; waiters = [];
        for (const x of w) x.rej(new Error("fake realtime: closed"));
      },
    };
    return s;
  };

  const routeWithHaiku: RouteWithHaiku = async ({ mark, mode, onDecision, onSpokenDelta, onSpokenEnd }) => {
    mark("llm.request", { mode });
    await wait(t.llmFirstMs);
    if (sc.failIn === "haiku") throw new Error("fake haiku: 529 overloaded");
    const usage = { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    mark("llm.firstToken");
    mark("llm.toolCall", { name: "route" });
    const routed: RouteIntent = intent === "clarify" ? "clarify" : mode === "forced" || sc.delegate ? intent : "answer";
    const decision = { intent: routed, estimateS: routed === "question" || routed === "task" ? estimateS : null };
    onDecision?.(decision);
    if (routed === "clarify" || routed === "answer") {
      for (const w of (routed === "clarify" ? CLARIFY : DIRECT_ANSWER).split(/(?<= )/)) { onSpokenDelta(w, "answer"); await wait(t.chunkMs); }
      onSpokenEnd?.("answer");
      return { delegate: null, decision, usage };
    }
    for (const w of ACK.split(/(?<= )/)) { onSpokenDelta(w, "ack"); await wait(t.chunkMs); }
    onSpokenEnd?.("ack");
    await wait(t.llmFirstMs); // the `question` field
    return { delegate: { question: "Why is the features section a CSS grid?", intent: routed, estimateS }, decision, usage };
  };

  const generateFillers: GenerateFillers = async () => {
    await wait(t.llmFirstMs);
    return { lines: sc.fillerLines ?? FILLER_LINES, usage: { input_tokens: 300, output_tokens: 30 } };
  };

  const solveWithOpus: SolveWithOpus = async ({ mark, fast, onSpokenLine, onDelta }) => {
    mark("opus.request", { fast });
    await wait(t.opusFirstMs);
    if (sc.failIn === "opus") throw new Error("fake opus: 500");
    mark("opus.firstToken");
    const text = `SPOKEN: ${SPOKEN_LINE}\n\nThe features section uses \`display: grid\` (demo.css:40) so the cards share column widths.`;
    onDelta(`SPOKEN: ${SPOKEN_LINE}\n`);
    await wait(t.opusFirstMs);
    mark("opus.spokenReady", { viaPrefix: true });
    onSpokenLine(SPOKEN_LINE);
    onDelta(text.slice(`SPOKEN: ${SPOKEN_LINE}\n`.length));
    await wait(t.opusFirstMs);
    mark("opus.done", { stopReason: "end_turn" });
    return { text, usage: { input_tokens: 200, output_tokens: 300, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, speed: fast ? "fast" : "standard" } };
  };

  return { openScribe, openTts, openRealtime, routeWithHaiku, solveWithOpus, generateFillers, voiceId: "fake-voice", log };
}
