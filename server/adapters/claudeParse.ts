// Pure incremental parsers used by the Claude adapter (claude.ts). Unit tested in claudeParse.test.ts.

// ── Ack extractor ──────────────────────────────────────────────────────────
// Pulls the decoded characters of one top-level string field (default "ack") out of a
// JSON object that arrives in arbitrary fragments (input_json_delta.partial_json), so
// they can be spoken before the tool input is complete. Handles every JSON escape,
// including \uXXXX surrogate pairs and escapes split across fragments.

type Container = { kind: "object"; expectKey: boolean } | { kind: "array" };

export class JsonStringFieldExtractor {
  private stack: Container[] = [];
  private inString = false;
  private stringIsKey = false;
  private emitting = false;
  private keyBuf = "";
  private lastKey: string | null = null;
  private escape = false;
  private unicodeHex: string | null = null;
  private pendingHigh: number | null = null;
  private _done = false;
  private _value = "";

  constructor(private readonly field = "ack") {}

  /** True once the field's closing quote has been seen. */
  get done(): boolean { return this._done; }
  /** Everything emitted so far. */
  get value(): string { return this._value; }

  /** Feed the next fragment; returns newly decoded characters of the field (may be ""). */
  feed(chunk: string): string {
    let out = "";
    for (const ch of chunk) {
      if (this.inString) {
        const decoded = this.stringChar(ch);
        if (decoded === null) continue;
        if (this.stringIsKey) this.keyBuf += decoded;
        else if (this.emitting) out += decoded;
        continue;
      }
      this.structuralChar(ch);
    }
    this._value += out;
    return out;
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
      if (this.stringIsKey) {
        this.keyBuf += tail;
        this.lastKey = this.keyBuf;
      } else if (this.emitting) {
        this._value += tail;
        this.emitting = false;
        this._done = true;
      }
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

  private structuralChar(ch: string): void {
    const top = this.stack[this.stack.length - 1];
    switch (ch) {
      case "{": this.stack.push({ kind: "object", expectKey: true }); break;
      case "[": this.stack.push({ kind: "array" }); break;
      case "}": case "]": this.stack.pop(); break;
      case ":": if (top?.kind === "object") top.expectKey = false; break;
      case ",": if (top?.kind === "object") { top.expectKey = true; this.lastKey = null; } break;
      case '"': {
        this.inString = true;
        this.stringIsKey = top?.kind === "object" && top.expectKey;
        if (this.stringIsKey) this.keyBuf = "";
        else this.emitting = !this._done && this.stack.length === 1 && top?.kind === "object" && this.lastKey === this.field;
        break;
      }
      default: break; // whitespace, numbers, literals
    }
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
