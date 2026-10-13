// DEV ONLY (?fake=1): an in-browser stand-in for the server so the lab UI can be exercised without keys or T7.
// It speaks shared/protocol.ts: plausible marks per approach, transcript/voice/opus text, short PCM tones for the
// ack and answer segments, then turn.done with a RunRecord. Loaded with a dynamic import, so it's a separate chunk
// that the production path never fetches.
import type { RunConfig } from "../../shared/config.ts";
import { deriveMetrics, type MarkName } from "../../shared/marks.ts";
import { resolvePointing } from "../../shared/pointing.ts";
import type { ClientMsg, CursorSample, PointingTarget, RunRecord, Segment, ServerMsg, Word } from "../../shared/protocol.ts";
import { encodeWav } from "../audio/wav.ts";
import type { Fixture } from "./fixtures.ts";
import type { LabSocketLike } from "./socket.ts";

const RATE = 24_000;
const FRAME = 480;

interface FakeTurn {
  turnId: string;
  config: RunConfig;
  fixtureId?: string;
  marks: Partial<Record<MarkName, number>>;
  samples: CursorSample[];
  tAudioStart?: number;
  frames: number;
  timers: ReturnType<typeof setTimeout>[];
  sent: Set<Segment>;
  played: Set<Segment>;
  voice: string;
  opus: string;
  transcript: string;
  words: Word[];
  pointing: PointingTarget[];
  cancelled: boolean;
}

const PHRASE = "Why is this section built with a grid instead of flexbox";
const ACK = "Let me check the styles for that section. ";
const SPOKEN = "The card section uses CSS grid so the cards line up in equal columns and wrap cleanly at every width.";
const DETAIL =
  "SPOKEN: " + SPOKEN + "\n\nDetails:\n- `.cards` is `display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))`.\n" +
  "- DECISIONS.md (2026-09-02) records the choice: flexbox left ragged last rows.\n- <script>alert('not html')</script> is rendered as text.";

/** Positive jitter around a median: median · e^(σ·N(0,1)). */
function jitter(median: number, sigma = 0.25): number {
  const u = 1 - Math.random();
  const v = Math.random();
  const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return median * Math.exp(sigma * n);
}

function tone(freq: number, ms: number): Int16Array<ArrayBuffer>[] {
  const n = Math.round((RATE * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 480, (n - i) / 480);
    out[i] = Math.round(0.18 * env * 32767 * Math.sin((2 * Math.PI * freq * i) / RATE));
  }
  const frames: Int16Array<ArrayBuffer>[] = [];
  for (let i = 0; i < n; i += FRAME) frames.push(out.slice(i, i + FRAME));
  return frames;
}

export class FakeSocket implements LabSocketLike {
  readonly isOpen = true;
  readonly clock = { rttMs: 0.4, offsetMs: 0 };
  private listeners = new Set<(m: ServerMsg) => void>();
  private audioListeners = new Set<(pcm: ArrayBuffer) => void>();
  private turn: FakeTurn | null = null;

  on(l: (m: ServerMsg) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  onAudio(l: (pcm: ArrayBuffer) => void) {
    this.audioListeners.add(l);
    return () => this.audioListeners.delete(l);
  }
  toClientTime(serverNow: number): number {
    return serverNow - this.clock.offsetMs;
  }

  private emit(m: ServerMsg): void {
    // Async like a real socket, so handlers never re-enter send().
    queueMicrotask(() => this.listeners.forEach((l) => l(m)));
  }

  sendAudio(): void {
    const t = this.turn;
    if (!t || t.marks.release !== undefined || t.config.approach === "realtime") return;
    t.frames++;
    if (t.frames % 15 === 0) {
      const words = PHRASE.split(" ");
      const k = Math.min(words.length, Math.ceil(t.frames / 15));
      if (t.marks["stt.firstPartial"] === undefined) this.mark(t, "stt.firstPartial");
      this.emit({ type: "stt.partial", turnId: t.turnId, text: words.slice(0, k).join(" ") });
    }
  }

  send(msg: ClientMsg): void {
    const t = this.turn;
    switch (msg.type) {
      case "turn.start":
        if (t) this.cleanup(t);
        this.turn = {
          turnId: msg.turnId, config: msg.config, fixtureId: msg.fixtureId, marks: { press: msg.tPress }, samples: [],
          frames: 0, timers: [], sent: new Set(), played: new Set(), voice: "", opus: "", transcript: "", words: [], pointing: [], cancelled: false,
        };
        return;
      case "turn.audioStart":
        if (t?.turnId === msg.turnId) t.tAudioStart = msg.tAudioStart;
        return;
      case "cursor.samples":
        if (t?.turnId === msg.turnId) t.samples.push(...msg.samples);
        return;
      case "turn.release":
        if (t?.turnId === msg.turnId) {
          t.marks.release = msg.tRelease;
          this.script(t);
        }
        return;
      case "audio.played":
        if (t?.turnId === msg.turnId) {
          t.played.add(msg.segment);
          t.marks[`${msg.segment}.played`] = msg.tPlayed;
        }
        return;
      case "turn.cancel":
        if (t?.turnId === msg.turnId) this.cleanup(t);
        return;
      default:
        return;
    }
  }

  private cleanup(t: FakeTurn): void {
    t.cancelled = true;
    t.timers.forEach(clearTimeout);
    if (this.turn === t) this.turn = null;
  }

  private mark(t: FakeTurn, name: MarkName, meta?: Record<string, unknown>): void {
    const now = performance.now();
    t.marks[name] = now;
    this.emit({ type: "mark", turnId: t.turnId, name, serverNow: now + this.clock.offsetMs, ...(meta ? { meta } : {}) });
  }

  private at(t: FakeTurn, ms: number, fn: () => void): void {
    t.timers.push(setTimeout(() => !t.cancelled && fn(), Math.max(0, ms)));
  }

  /** Stream text in a few deltas between from and to (ms from now). */
  private stream(t: FakeTurn, kind: "voice.text" | "opus.text", text: string, from: number, to: number): void {
    const parts = text.match(/.{1,24}(\s|$)|.{1,24}/gs) ?? [text];
    parts.forEach((p, i) => this.at(t, from + ((to - from) * i) / parts.length, () => {
      if (kind === "voice.text") t.voice += p;
      else t.opus += p;
      this.emit({ type: kind, turnId: t.turnId, delta: p });
    }));
  }

  private segment(t: FakeTurn, seg: Segment, startMs: number, freq: number, durMs: number): number {
    const frames = tone(freq, durMs);
    this.at(t, startMs, () => {
      this.mark(t, `${seg}.ttsFirstByte`);
      t.sent.add(seg);
      this.emit({ type: "audio.segment", turnId: t.turnId, segment: seg, state: "start" });
      // Deliver faster than real time in 100 ms bursts, like a TTS stream.
      for (let i = 0; i < frames.length; i += 5) {
        this.at(t, (i / 5) * 60, () => {
          for (const f of frames.slice(i, i + 5)) queueMicrotask(() => this.audioListeners.forEach((l) => l(f.buffer.slice(0))));
          if (i + 5 >= frames.length) this.emit({ type: "audio.segment", turnId: t.turnId, segment: seg, state: "end" });
        });
      }
    });
    return startMs + (frames.length / 5) * 60;
  }

  /** Schedule the whole post-release turn (times in ms from release). */
  private script(t: FakeTurn): void {
    const c = t.config;
    const usesScribe = c.approach !== "realtime";
    const rt = c.approach !== "pipeline";
    const opusScale = c.opusFast ? 0.5 : 1;
    const rtScale = c.realtimeModel === "gpt-realtime-2.1-mini" ? 0.7 : 1;
    const delegate = !(c.approach === "pipeline" && c.routerMode === "auto" && Math.random() < 0.35);
    let last = 0;

    let tStt = 0;
    if (usesScribe) {
      tStt = jitter(190);
      t.transcript = PHRASE + "?";
      t.words = PHRASE.split(" ").map((w, i) => ({ text: w, start: 0.3 + i * 0.12, end: 0.4 + i * 0.12 }));
      this.at(t, tStt, () => {
        this.mark(t, "stt.final", { timestamped: true, words: t.words.length });
        this.emit({ type: "stt.final", turnId: t.turnId, text: t.transcript, words: t.words });
      });
    }
    const tWaited = c.approach === "hybrid" ? Math.min(tStt, c.hybridWaitMs) : tStt;
    const pointingOk = usesScribe && tStt <= (c.approach === "hybrid" ? c.hybridWaitMs : Infinity);
    if (pointingOk) {
      this.at(t, tWaited + 3, () => {
        const targets = resolvePointing(t.words, t.tAudioStart ?? t.marks.press ?? 0, t.samples, { preMs: c.preMs, postMs: c.postMs });
        t.pointing = targets;
        this.mark(t, "pointing.resolved", { targets: targets.length });
        this.emit({ type: "pointing.resolved", turnId: t.turnId, targets });
      });
    } else if (c.approach === "hybrid") {
      this.at(t, tWaited, () => this.emit({ type: "error", turnId: t.turnId, source: "fake.hybrid", message: `Scribe missed the ${c.hybridWaitMs} ms window; responding without pointing` }));
    }

    const tReq = (usesScribe ? tWaited + 6 : 4);
    this.at(t, tReq, () => this.mark(t, "llm.request"));
    const tFirst = tReq + (rt ? jitter(360 * rtScale) : jitter(300));
    this.at(t, tFirst, () => this.mark(t, "llm.firstToken"));

    if (!delegate) {
      const answer = "That button is blue, hex 2a78d6.";
      this.stream(t, "voice.text", answer, tFirst, tFirst + 300);
      last = this.segment(t, "answer", tFirst + jitter(200), 330, 1100);
    } else {
      const tTool = tFirst + jitter(rt ? 420 : 60);
      this.at(t, tTool, () => this.mark(t, "llm.toolCall", { name: "ask_opus" }));
      this.stream(t, "voice.text", ACK, tFirst, tFirst + 250);
      const tAck = rt ? tFirst + 2 : tFirst + jitter(190);
      const ackEnd = this.segment(t, "ack", tAck, 440, 900);
      const tOpusReq = tTool + jitter(40);
      this.at(t, tOpusReq, () => this.mark(t, "opus.request"));
      const tOpusFirst = tOpusReq + jitter(1100 * opusScale);
      this.at(t, tOpusFirst, () => this.mark(t, "opus.firstToken"));
      const tSpoken = tOpusFirst + jitter(700 * opusScale);
      this.at(t, tSpoken, () => this.mark(t, "opus.spokenReady"));
      const tOpusDone = tSpoken + jitter(2200 * opusScale);
      this.stream(t, "opus.text", DETAIL, tOpusFirst, tOpusDone);
      this.at(t, tOpusDone, () => this.mark(t, "opus.done"));
      this.stream(t, "voice.text", SPOKEN, tSpoken + 100, tSpoken + 900);
      const answerEnd = this.segment(t, "answer", Math.max(ackEnd + 50, tSpoken + jitter(rt ? 380 * rtScale : 210)), 330, 1500);
      last = Math.max(answerEnd, tOpusDone);
    }

    this.at(t, last + 20, () => {
      this.mark(t, "turn.end");
      // Like the server: wait (≤ 3 s) for audio.played of every segment sent, then turn.done.
      const deadline = performance.now() + 3000;
      const finish = () => {
        if (t.cancelled) return;
        const allPlayed = [...t.sent].every((s) => t.played.has(s));
        if (!allPlayed && performance.now() < deadline) return void t.timers.push(setTimeout(finish, 50));
        this.emit({ type: "turn.done", turnId: t.turnId, run: this.record(t) });
        if (this.turn === t) this.turn = null;
      };
      finish();
    });
  }

  private record(t: FakeTurn): RunRecord {
    const c = t.config;
    const opusTokens = t.opus.length / 4;
    const cost = (c.approach === "pipeline" ? 0.002 : 0.012) + (t.opus ? opusTokens * (c.opusFast ? 40 : 25) / 1e6 + 0.004 : 0);
    return {
      runId: crypto.randomUUID(), turnId: t.turnId, approach: c.approach, config: c, ...(t.fixtureId ? { fixtureId: t.fixtureId } : {}),
      marks: t.marks, metrics: deriveMetrics(t.marks), transcript: t.transcript, pointing: t.pointing, voiceText: t.voice, opusText: t.opus,
      usage: { elevenChars: t.voice.length, scribeSeconds: (t.frames * 20) / 1000 }, costUsd: cost, clock: { ...this.clock },
    };
  }
}

/** A synthetic 1.6 s fixture (hummed tone + a cursor trail that dwells on one target) for fake-mode replays. */
export function fakeFixture(): Fixture {
  const frames = tone(180, 1600);
  const wav = new Blob([encodeWav(frames, RATE)], { type: "audio/wav" });
  const samples: CursorSample[] = [];
  for (let tm = -500; tm <= 1900; tm += 16) {
    const still = tm > 500 && tm < 1000;
    const x = still ? 400 : 200 + tm / 5;
    samples.push({
      t: tm, x, y: 300, scrollX: 0, scrollY: 0,
      elementPath: still ? "div#demo-root > main > section#cards" : "div#demo-root > main",
      dataSource: still ? "web/cursor/demo/demo.html:40" : null, label: still ? "Card grid" : null,
    });
  }
  return { id: "FAKE01", transcript: PHRASE + "?", samples, pointingWords: 1, labeled: 0, wav, origin: "fake" };
}
