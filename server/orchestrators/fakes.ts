// Fake adapters with plausible timing and the same marks as the real ones. Used by the orchestrator
// unit tests and by `npm run smoke:e2e -- --fake` (exercises the whole server path without keys).
import type { GenerateFillers, HarnessThread, OpenHarnessThread, RouteDecision, RouteTarget, SolveInThread,
  OpenScribe, OpenTts, RouteTurn, SolveTask, SttStream, TtsStream,
} from "../adapters/types.ts";
import type { Mark } from "../clock.ts";
import type { LlmPrompt, LlmResponse, RouteIntent, Word } from "../../shared/protocol.ts";
import type { OrchestratorDeps } from "./types.ts";

export interface FakeTiming {
  /** Socket open delay for every adapter. */
  openMs: number;
  /** Commit → Scribe final. */
  sttFinalMs: number;
  /** Request → first token (router). */
  llmFirstMs: number;
  /** Request → first token (the solver); spoken line follows after the same again. */
  solverFirstMs: number;
  /** flush → first TTS audio. */
  ttsFirstMs: number;
  /** Gap between audio chunks. */
  chunkMs: number;
}

export const FAST_TIMING: FakeTiming = { openMs: 2, sttFinalMs: 5, llmFirstMs: 3, solverFirstMs: 5, ttsFirstMs: 3, chunkMs: 1 };
export const REALISTIC_TIMING: FakeTiming = { openMs: 120, sttFinalMs: 180, llmFirstMs: 250, solverFirstMs: 900, ttsFirstMs: 150, chunkMs: 20 };

export interface FakeScenario {
  /** The router (auto mode): delegate to the solver (otherwise it answers directly). */
  delegate: boolean;
  transcript: string;
  words: Word[];
  /** Throw from this adapter (on open, unless noted). */
  failIn?: "scribe" | "tts" | "router" | "solver";
  /** Scribe never produces a final. */
  scribeHangs?: boolean;
  /** Router decision (default question, 10 s). "clarify": asks a follow-up instead of delegating. */
  intent?: "question" | "task" | "clarify";
  estimateS?: number;
  /** Lines generateFillers returns (default two lines). */
  fillerLines?: string[];
  /** Threads mode (the router got `threads`): where the router sends the turn (default new) and a tell. */
  target?: RouteTarget;
  tell?: string;
  /** Element threads: how long one thread request takes (default 3 × solverFirstMs) and the files it edits. */
  threadRunMs?: number;
  filesTouched?: string[];
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
  /** Element threads: every request sent to a thread session, and thread aborts/closes. */
  threadSends: { threadId: string; kind: string; question: string; replay: string }[];
  threadAborts: string[];
  threadClosed: string[];
}

export function createFakeDeps(t: FakeTiming = FAST_TIMING, sc: FakeScenario = DEFAULT_SCENARIO): OrchestratorDeps & { log: FakeLog } {
  const log: FakeLog = { opened: [], closed: [], threadSends: [], threadAborts: [], threadClosed: [] };
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

  const fakePrompt = (target: LlmPrompt["target"], text: string): LlmPrompt =>
    ({ target, model: `fake-${target}`, system: [{ label: `${target}.md`, text: "(fake instructions)", cached: true }], messages: [{ role: "user", text, label: "this turn" }] });

  const fakeResponse = (target: LlmPrompt["target"], stopReason: string, usage: unknown): LlmResponse =>
    ({ target, model: `fake-${target}`, stopReason, usage, durationMs: 1, raw: { type: "message", stop_reason: stopReason, usage } });

  const routeTurn: RouteTurn = async ({ mark, mode, transcript, onDecision, onSpokenDelta, onSpokenEnd, onPrompt, onResponse, threads }) => {
    onPrompt?.(fakePrompt("router", `Transcript: "${transcript}"`));
    mark("llm.request", { mode });
    await wait(t.llmFirstMs);
    if (sc.failIn === "router") throw new Error("fake router: 529 overloaded");
    const usage = { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    mark("llm.firstToken");
    mark("llm.toolCall", { name: "route" });
    if (threads && sc.tell) {
      // A tell: say and question empty, the server speaks the stored result.
      const decision: RouteDecision = { intent: "answer", estimateS: null, target: { kind: "thread", threadId: sc.tell, relation: "followup" }, tell: sc.tell };
      onDecision?.(decision);
      onResponse?.(fakeResponse("router", "tool_use", usage));
      return { delegate: null, decision, usage };
    }
    const routed: RouteIntent = intent === "clarify" ? "clarify" : mode === "forced" || sc.delegate ? intent : "answer";
    const decision: RouteDecision = {
      intent: routed, estimateS: routed === "question" || routed === "task" ? estimateS : null,
      ...(threads ? { target: sc.target ?? { kind: "new" } } : {}),
    };
    onDecision?.(decision);
    if (routed === "clarify" || routed === "answer") {
      for (const w of (routed === "clarify" ? CLARIFY : DIRECT_ANSWER).split(/(?<= )/)) { onSpokenDelta(w, "answer"); await wait(t.chunkMs); }
      onSpokenEnd?.("answer");
      onResponse?.(fakeResponse("router", "tool_use", usage));
      return { delegate: null, decision, usage };
    }
    for (const w of ACK.split(/(?<= )/)) { onSpokenDelta(w, "ack"); await wait(t.chunkMs); }
    onSpokenEnd?.("ack");
    await wait(t.llmFirstMs); // the `question` field
    onResponse?.(fakeResponse("router", "tool_use", usage));
    return { delegate: { question: "Why is the features section a CSS grid?", intent: routed, estimateS }, decision, usage };
  };

  const generateFillers: GenerateFillers = async ({ question, onPrompt, onResponse }) => {
    onPrompt?.(fakePrompt("fillers", question));
    await wait(t.llmFirstMs);
    onResponse?.(fakeResponse("fillers", "tool_use", { input_tokens: 300, output_tokens: 30 }));
    return { lines: sc.fillerLines ?? FILLER_LINES, usage: { input_tokens: 300, output_tokens: 30 } };
  };

  const solveTask: SolveTask = async ({ mark, fast, onSpokenLine, onDelta, question, onPrompt, onResponse }) => {
    onPrompt?.(fakePrompt("solver", `Question: ${question}`));
    mark("solver.request", { fast });
    await wait(t.solverFirstMs);
    if (sc.failIn === "solver") throw new Error("fake solver: 500");
    mark("solver.firstToken");
    const text = `SPOKEN: ${SPOKEN_LINE}\n\nThe features section uses \`display: grid\` (demo.css:40) so the cards share column widths.`;
    onDelta(`SPOKEN: ${SPOKEN_LINE}\n`);
    await wait(t.solverFirstMs);
    mark("solver.spokenReady", { viaPrefix: true });
    onSpokenLine(SPOKEN_LINE);
    onDelta(text.slice(`SPOKEN: ${SPOKEN_LINE}\n`.length));
    await wait(t.solverFirstMs);
    mark("solver.done", { stopReason: "end_turn" });
    onResponse?.(fakeResponse("solver", "end_turn", { input_tokens: 200, output_tokens: 300, cache_read_input_tokens: 5000 }));
    return { text, usage: { input_tokens: 200, output_tokens: 300, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, speed: fast ? "fast" : "standard" } };
  };

  const threadRunMs = sc.threadRunMs ?? t.solverFirstMs * 3;
  let threadSeq = 0;
  const openThread: OpenHarnessThread = ({ choice, replay }) => {
    const id = `thread#${++threadSeq}`;
    let pending: { reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
    let live = false;
    const h: HarnessThread = {
      id, choice,
      send(user, onText) {
        const reopened = !live && replay() !== "";
        log.threadSends.push({ threadId: id, kind: "", question: user, replay: live ? "" : replay() });
        live = true;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending = null;
            const text = `SPOKEN: Done: ${user.split("\n")[0]}\n\nDetails of the change.`;
            onText?.(text);
            resolve({ text, model: "fake-thread", stopReason: "end_turn", usage: { input_tokens: 100, output_tokens: 50 }, filesTouched: sc.filesTouched ?? [], reopened } as Awaited<ReturnType<HarnessThread["send"]>>);
          }, threadRunMs);
          pending = { reject, timer };
        });
      },
      abort() {
        log.threadAborts.push(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        const e = new Error("aborted");
        e.name = "AbortError";
        pending.reject(e);
        pending = null;
      },
      close() { log.threadClosed.push(id); h.abort(); live = false; },
      get live() { return live; },
    };
    return h;
  };

  const solveInThread: SolveInThread = async ({ thread, kind, question, onSpokenLine, onDelta, onPrompt, onResponse }) => {
    onPrompt?.(fakePrompt("solver", `(${kind}) ${question}`));
    const n = log.threadSends.length;
    const p = thread.send(question, undefined, 60_000);
    if (log.threadSends[n]) log.threadSends[n]!.kind = kind;
    const r = await p;
    const spoken = r.text.split("\n")[0]!.replace(/^SPOKEN:\s*/, "");
    onSpokenLine(spoken);
    onDelta(r.text);
    onResponse?.(fakeResponse("solver", "end_turn", r.usage));
    return { text: r.text, usage: r.usage, filesTouched: r.filesTouched };
  };

  return { openScribe, openTts, routeTurn, solveTask, generateFillers, openThread, solveInThread, voiceId: "fake-voice", log };
}
