// Pure incremental parsers used by the Claude adapter (claude.ts). Unit tested in claudeParse.test.ts.

// ── Streaming top-level JSON fields ────────────────────────────────────────
// Reads a JSON object that arrives in arbitrary fragments (input_json_delta.partial_json) and
// reports its TOP-LEVEL fields as they stream: each key, the decoded characters of string values
// (so they can be spoken before the object is complete), and each completed value. Handles every
// JSON escape, including \uXXXX surrogate pairs and escapes split across fragments. Nested
// objects/arrays are skipped (their keys and values are never reported).

type Container = { kind: "object"; expectKey: boolean } | { kind: "array" };

export interface JsonFieldEvents {
  /** A top-level key was read; its value comes next. */
  onKey?(key: string): void;
  /** Newly decoded characters of a top-level string value. */
  onStringDelta?(key: string, chunk: string): void;
  /** A top-level string or primitive value is complete (numbers/true/false/null are JSON-parsed). */
  onValue?(key: string, value: unknown): void;
}

export class JsonTopLevelStream {
  private stack: Container[] = [];
  private inString = false;
  private stringIsKey = false;
  /** The current string is a top-level key (reported). */
  private keyTop = false;
  /** The current string is a top-level value (reported). */
  private valueTop = false;
  private keyBuf = "";
  private valueBuf = "";
  /** Key of the top-level value being read; null between fields. */
  private lastKey: string | null = null;
  /** Raw characters of a top-level primitive value being read (null when not in one). */
  private prim: string | null = null;
  private escape = false;
  private unicodeHex: string | null = null;
  private pendingHigh: number | null = null;

  constructor(private readonly ev: JsonFieldEvents) {}

  feed(chunk: string): void {
    let out = "";
    const flushOut = (): void => {
      if (out && this.lastKey !== null) this.ev.onStringDelta?.(this.lastKey, out);
      out = "";
    };
    for (const ch of chunk) {
      if (this.inString) {
        const decoded = this.stringChar(ch);
        if (decoded === null) { // closing quote
          if (this.keyTop) {
            this.lastKey = this.keyBuf;
            this.ev.onKey?.(this.keyBuf);
          } else if (this.valueTop) {
            flushOut();
            this.ev.onValue?.(this.lastKey!, this.valueBuf);
          }
          continue;
        }
        if (this.keyTop) this.keyBuf += decoded;
        else if (this.valueTop) { out += decoded; this.valueBuf += decoded; }
        continue;
      }
      this.structuralChar(ch);
    }
    flushOut();
  }

  /** Returns the decoded text for one char inside a string, "" if consumed, or null at the closing quote. */
  private stringChar(ch: string): string | null {
    if (this.unicodeHex !== null) {
      this.unicodeHex += ch;
      if (this.unicodeHex.length < 4) return "";
      const code = Number.parseInt(this.unicodeHex, 16);
      this.unicodeHex = null;
      if (Number.isNaN(code)) return "";
      return this.codeUnit(code);
    }
    if (this.escape) {
      this.escape = false;
      switch (ch) {
        case "n": return this.flushHigh() + "\n";
        case "t": return this.flushHigh() + "\t";
        case "r": return this.flushHigh() + "\r";
        case "b": return this.flushHigh() + "\b";
        case "f": return this.flushHigh() + "\f";
        case "u": this.unicodeHex = ""; return "";
        default: return this.flushHigh() + ch; // \" \\ \/ (and anything else, verbatim)
      }
    }
    if (ch === "\\") { this.escape = true; return ""; }
    if (ch === '"') {
      const tail = this.flushHigh();
      this.inString = false;
      if (this.keyTop) this.keyBuf += tail;
      else if (this.valueTop) this.valueBuf += tail; // a lone high surrogate right before the quote
      return null;
    }
    return this.flushHigh() + ch;
  }

  /** UTF-16 code unit from \uXXXX; holds a high surrogate until its low half arrives. */
  private codeUnit(code: number): string {
    if (code >= 0xd800 && code <= 0xdbff) {
      const prev = this.flushHigh();
      this.pendingHigh = code;
      return prev;
    }
    if (code >= 0xdc00 && code <= 0xdfff && this.pendingHigh !== null) {
      const pair = String.fromCharCode(this.pendingHigh, code);
      this.pendingHigh = null;
      return pair;
    }
    return this.flushHigh() + String.fromCharCode(code);
  }

  private flushHigh(): string {
    if (this.pendingHigh === null) return "";
    const s = String.fromCharCode(this.pendingHigh); // lone surrogate: pass through
    this.pendingHigh = null;
    return s;
  }

  /** Inside the top-level object, after a key's colon. */
  private atTopValue(): boolean {
    const top = this.stack[this.stack.length - 1];
    return this.stack.length === 1 && top?.kind === "object" && !top.expectKey && this.lastKey !== null;
  }

  private endPrim(): void {
    if (this.prim === null) return;
    const raw = this.prim;
    this.prim = null;
    let v: unknown = raw;
    try { v = JSON.parse(raw); } catch { /* keep the raw text */ }
    this.ev.onValue?.(this.lastKey!, v);
  }

  private structuralChar(ch: string): void {
    if (this.prim !== null) {
      if (ch !== "," && ch !== "}" && !/\s/.test(ch)) { this.prim += ch; return; }
      this.endPrim();
    }
    const top = this.stack[this.stack.length - 1];
    switch (ch) {
      case "{": this.stack.push({ kind: "object", expectKey: true }); break;
      case "[": this.stack.push({ kind: "array" }); break;
      case "}": case "]": this.stack.pop(); break;
      case ":": if (top?.kind === "object") top.expectKey = false; break;
      case ",":
        if (top?.kind === "object") top.expectKey = true;
        if (this.stack.length === 1) this.lastKey = null;
        break;
      case '"': {
        this.inString = true;
        this.stringIsKey = top?.kind === "object" && top.expectKey;
        this.keyTop = this.stringIsKey && this.stack.length === 1;
        this.valueTop = !this.stringIsKey && this.atTopValue();
        if (this.keyTop) this.keyBuf = "";
        else if (this.valueTop) this.valueBuf = "";
        break;
      }
      default:
        if (!/\s/.test(ch) && this.atTopValue()) this.prim = ch; // number / true / false / null
        break;
    }
  }
}

// ── Single string field extractor ──────────────────────────────────────────
// The decoded characters of ONE top-level string field (default "ack"), first occurrence only,
// returned from feed() as they arrive.

export class JsonStringFieldExtractor {
  private readonly parser: JsonTopLevelStream;
  private _done = false;
  private _value = "";
  private active = false;
  private out = "";

  constructor(private readonly field = "ack") {
    this.parser = new JsonTopLevelStream({
      onKey: (k) => { this.active = !this._done && k === this.field; },
      onStringDelta: (k, chunk) => { if (this.active && k === this.field) this.out += chunk; },
      onValue: (k) => { if (this.active && k === this.field) { this._done = true; this.active = false; } },
    });
  }

  /** True once the field's closing quote has been seen. */
  get done(): boolean { return this._done; }
  /** Everything emitted so far. */
  get value(): string { return this._value; }

  /** Feed the next fragment; returns newly decoded characters of the field (may be ""). */
  feed(chunk: string): string {
    this.out = "";
    this.parser.feed(chunk);
    this._value += this.out;
    return this.out;
  }
}

// ── Router `route` tool input, streamed ────────────────────────────────────
// The router fills {intent, estimate_seconds, say, question} in that order. This turns the streamed
// fields into: one decision (as soon as `intent` is known, plus `estimate_seconds` for
// question/task), then the `say` text with its kind, then the end of `say`. `say` text that streams
// before the decision is buffered and released right after it, so the decision always comes first.

export type RouteIntentName = "question" | "task" | "clarify" | "answer";
export type SpokenKind = "ack" | "answer";
export interface RouteDecisionLite { intent: RouteIntentName; estimateS: number | null }

export interface RouteStreamEvents {
  onDecision(d: RouteDecisionLite): void;
  onSay(delta: string, kind: SpokenKind): void;
  onSayEnd(kind: SpokenKind): void;
}

/** "ack" when a delegation follows (question/task), "answer" when `say` is the whole reply. */
export const kindFor = (intent: RouteIntentName): SpokenKind => (intent === "question" || intent === "task" ? "ack" : "answer");

/** Seconds as a positive integer, or null. Accepts numbers and numeric strings. */
export function parseEstimate(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.round(n));
}

export interface RouteFields { intent?: unknown; estimate_seconds?: unknown; say?: unknown; question?: unknown }

export class RouteInputStream {
  private readonly parser: JsonTopLevelStream;
  private intent: RouteIntentName | null = null;
  private estimate: number | null = null;
  private estimateSeen = false;
  private question = "";
  private sayBuf = "";
  private sayStreamed = "";
  private sayActive = false;
  private saySeen = false;
  private sayClosed = false;
  private sayEnded = false;
  private _decision: RouteDecisionLite | null = null;

  /**
   * @param allowed intents accepted for this request (others count as missing)
   * @param fallbackIntent assumed at the end when no usable intent arrived and there is no question
   *   (with a question, "question" is assumed)
   */
  constructor(
    private readonly ev: RouteStreamEvents,
    private readonly allowed: readonly RouteIntentName[],
    private readonly fallbackIntent: RouteIntentName,
  ) {
    this.parser = new JsonTopLevelStream({
      onKey: (k) => {
        this.sayActive = k === "say" && !this.sayClosed;
        if (this.sayActive) this.saySeen = true;
      },
      onStringDelta: (k, chunk) => {
        if (k === "say" && this.sayActive) this.sayDelta(chunk);
        else if (k === "question") this.question += chunk;
      },
      onValue: (k, v) => this.value(k, v),
    });
  }

  get decision(): RouteDecisionLite | null { return this._decision; }
  /** All `say` text released to onSay so far. */
  get spoken(): string { return this.sayStreamed; }
  /** `say` reached its closing quote and was released. */
  get sayComplete(): boolean { return this.sayClosed && this._decision !== null; }

  feed(chunk: string): void { this.parser.feed(chunk); }

  /**
   * The tool block ended. `final` is the complete input when known: it fills what didn't stream.
   * Makes the decision if still pending (inferring the intent if needed), releases any buffered or
   * missing `say` text and ends `say`. Safe to call more than once.
   */
  finish(final?: RouteFields | null): void {
    if (!this._decision) {
      if (!this.intent && this.isAllowed(final?.intent)) this.intent = final!.intent as RouteIntentName;
      if (!this.estimateSeen && final && "estimate_seconds" in final) this.estimate = parseEstimate(final.estimate_seconds);
      const q = typeof final?.question === "string" ? final.question : this.question;
      this.decide(this.intent ?? (q.trim() ? "question" : this.fallbackIntent));
    }
    const finalSay = typeof final?.say === "string" ? final.say : null;
    if (finalSay !== null && finalSay.startsWith(this.sayStreamed) && finalSay.length > this.sayStreamed.length) {
      this.saySeen = true;
      this.emit(finalSay.slice(this.sayStreamed.length));
    }
    if (this.saySeen) this.endSay();
  }

  private isAllowed(v: unknown): boolean {
    return typeof v === "string" && (this.allowed as readonly string[]).includes(v);
  }

  private value(k: string, v: unknown): void {
    if (k === "intent") {
      if (this.intent || !this.isAllowed(v)) return;
      this.intent = v as RouteIntentName;
      if (!this._decision && (kindFor(this.intent) === "answer" || this.estimateSeen)) this.decide(this.intent);
    } else if (k === "estimate_seconds") {
      if (this.estimateSeen) return;
      this.estimateSeen = true;
      this.estimate = parseEstimate(v);
      if (!this._decision && this.intent) this.decide(this.intent);
    } else if (k === "say" && this.sayActive) {
      this.sayActive = false;
      this.sayClosed = true;
      // Out-of-order fields: no estimate before `say` ended. Don't hold the speech any longer.
      if (!this._decision && this.intent) this.decide(this.intent);
      else if (this._decision) this.endSay();
    }
  }

  private sayDelta(chunk: string): void {
    if (this._decision) this.emit(chunk);
    else this.sayBuf += chunk;
  }

  private decide(intent: RouteIntentName): void {
    this._decision = { intent, estimateS: kindFor(intent) === "ack" ? this.estimate : null };
    this.ev.onDecision(this._decision);
    if (this.sayBuf) { const b = this.sayBuf; this.sayBuf = ""; this.emit(b); }
    if (this.sayClosed) this.endSay();
  }

  private emit(d: string): void {
    if (!d) return;
    this.sayStreamed += d;
    this.ev.onSay(d, kindFor(this._decision!.intent));
  }

  private endSay(): void {
    if (this.sayEnded || !this._decision) return;
    this.sayEnded = true;
    this.ev.onSayEnd(kindFor(this._decision.intent));
  }
}

// ── SPOKEN line parser ─────────────────────────────────────────────────────
// Opus replies "SPOKEN: <1–3 sentences>\n\n<details>". The parser fires once, as soon as
// the spoken line is complete. If the model leaves out the prefix, it falls back to the
// first sentence(s) of the reply.

const PREFIX = "spoken:";
/** Strips leading markdown emphasis/heading noise like "**", "#", "> ". */
const LEAD_NOISE = /^(?:[#>*_\s]|-\s)*/;
const MIN_FALLBACK_CHARS = 24;
const MAX_FALLBACK_SENTENCES = 2;

export class SpokenLineParser {
  private buf = "";
  private mode: "detect" | "prefixed" | "fallback" = "detect";
  private _line: string | null = null;

  constructor(private readonly onLine: (line: string, viaPrefix: boolean) => void) {}

  get line(): string | null { return this._line; }

  feed(delta: string): void {
    if (this._line !== null) return;
    this.buf += delta;
    this.step(false);
  }

  /** Call at end of stream: emits whatever is available if the line never completed. */
  end(): string | null {
    if (this._line === null) this.step(true);
    return this._line;
  }

  private step(final: boolean): void {
    if (this.mode === "detect") {
      const head = this.buf.replace(LEAD_NOISE, "");
      const probe = head.slice(0, PREFIX.length).toLowerCase();
      if (head.length >= PREFIX.length) this.mode = probe === PREFIX ? "prefixed" : "fallback";
      else if (head.length > 0 && !PREFIX.startsWith(probe)) this.mode = "fallback";
      else if (!final) return;
      else this.mode = "fallback";
    }
    if (this.mode === "prefixed") this.stepPrefixed(final);
    else this.stepFallback(final);
  }

  private stepPrefixed(final: boolean): void {
    const head = this.buf.replace(LEAD_NOISE, "");
    const rest = head.slice(PREFIX.length);
    const nl = rest.indexOf("\n");
    if (nl < 0 && !final) return;
    const line = clean(nl < 0 ? rest : rest.slice(0, nl));
    if (line) this.emit(line, true);
    else if (nl >= 0) { // "SPOKEN:" alone on its line: take the next non-empty line instead
      this.buf = rest.slice(nl + 1);
      this.mode = "fallback";
      this.stepFallback(final);
    }
  }

  private stepFallback(final: boolean): void {
    const text = this.buf.replace(LEAD_NOISE, "");
    let end = -1;
    let sentences = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!;
      if (c === "\n") { if (text.slice(0, i).trim()) { end = i; break; } continue; }
      if ((c === "." || c === "!" || c === "?") && i + 1 < text.length && /\s/.test(text[i + 1]!)) {
        sentences++;
        if (i + 1 >= MIN_FALLBACK_CHARS || sentences >= MAX_FALLBACK_SENTENCES) { end = i + 1; break; }
      }
    }
    if (end < 0) {
      if (!final) return;
      end = text.length;
    }
    const line = clean(text.slice(0, end));
    if (line) this.emit(line, false);
  }

  private emit(line: string, viaPrefix: boolean): void {
    this._line = line;
    this.onLine(line, viaPrefix);
  }
}

function clean(s: string): string {
  return s.replace(/\*\*|__/g, "").replace(/`/g, "").trim();
}
