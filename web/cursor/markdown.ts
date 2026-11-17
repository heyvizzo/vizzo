// A small Markdown reader for agent answers ("Full answer" in the thread panels). parseMarkdown is pure (a block
// tree, tested without a DOM); renderMarkdown builds DOM nodes from it with createElement/textContent only, never
// innerHTML: the overlay runs inside arbitrary pages (some enforce Trusted Types), and the text is model output.
// Covers what agents write: headings, paragraphs, lists (nested), fenced code, quotes, rules, tables, and inline
// code, bold, italic, strikethrough and links. Links show their text with the URL as a tooltip: following one would
// navigate the browser pane away from the page being worked on.

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong" | "em" | "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: number; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "quote"; c: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "hr" }
  | { t: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

const indentOf = (s: string) => s.length - s.trimStart().length;
const blank = (s: string) => s.trim() === "";
const dedent = (s: string, n: number) => s.slice(Math.min(n, indentOf(s)));

/** A line that ends a paragraph (and so can't be a lazy continuation of one). */
function startsBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || ITEM.test(line);
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (ch === "`") code = !code;
    if (ch === "|" && !code) { cells.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

export function parseMarkdown(src: string): Block[] {
  return parseBlocks(src.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"));
}

function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (blank(line)) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1]!;
      const ind = indentOf(line);
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}\\s*$`).test(lines[i]!)) body.push(dedent(lines[i++]!, ind));
      i++; // the closing fence (or past the end)
      out.push({ t: "code", lang: fence[2] ?? "", v: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ t: "h", level: heading[1]!.length, c: parseInline(heading[2] ?? "") });
      i++;
      continue;
    }

    if (HR.test(line)) { out.push({ t: "hr" }); i++; continue; }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !blank(lines[i]!) && (QUOTE.test(lines[i]!) || !startsBlock(lines[i]!))) body.push(lines[i++]!.replace(QUOTE, ""));
      out.push({ t: "quote", c: parseBlocks(body) });
      continue;
    }

    const item = ITEM.exec(line);
    if (item) { i = parseList(lines, i, out); continue; }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]!).map((c): Align => {
        const l = c.startsWith(":"), r = c.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : null;
      });
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && !blank(lines[i]!) && lines[i]!.includes("|")) {
        const cells = splitRow(lines[i++]!);
        rows.push(head.map((_, k) => parseInline(cells[k] ?? "")));
      }
      out.push({ t: "table", align: head.map((_, k) => align[k] ?? null), head: head.map((c) => parseInline(c)), rows });
      continue;
    }

    const para: string[] = [line];
    i++;
    while (i < lines.length && !blank(lines[i]!) && !startsBlock(lines[i]!)) para.push(lines[i++]!);
    out.push({ t: "p", c: parseInline(para.map((l) => l.trim()).join("\n")) });
  }
  return out;
}

/** Reads one list starting at `start` into `out`; returns the index after it. */
function parseList(lines: string[], start: number, out: Block[]): number {
  const first = ITEM.exec(lines[start]!)!;
  const ordered = /\d/.test(first[2]!);
  const base = first[1]!.length;
  const items: Block[][] = [];
  let i = start;
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]!);
    if (!m || m[1]!.length > base + 3 || m[1]!.length < base || /\d/.test(m[2]!) !== ordered) break;
    const content = m[1]!.length + m[2]!.length + (m[3]!.length > 4 || !m[4] ? 1 : m[3]!.length);
    const body: string[] = [m[4]!];
    i++;
    while (i < lines.length) {
      const l = lines[i]!;
      if (blank(l)) {
        // A blank line continues the item only if what follows is indented into it.
        let j = i + 1;
        while (j < lines.length && blank(lines[j]!)) j++;
        if (j < lines.length && indentOf(lines[j]!) >= content) { body.push(...lines.slice(i, j).map(() => "")); i = j; continue; }
        break;
      }
      if (indentOf(l) >= content) { body.push(dedent(l, content)); i++; continue; }
      // Unindented text right after the item's text is a lazy continuation of its paragraph.
      if (!blank(body[body.length - 1]!) && !startsBlock(l)) { body.push(l.trim()); i++; continue; }
      break;
    }
    items.push(parseBlocks(body));
    // Blank lines between items don't end the list.
    let j = i;
    while (j < lines.length && blank(lines[j]!)) j++;
    const next = j < lines.length ? ITEM.exec(lines[j]!) : null;
    if (j > i && next && next[1]!.length >= base && next[1]!.length <= base + 3 && /\d/.test(next[2]!) === ordered) i = j;
  }
  out.push({ t: "list", ordered, start: ordered ? parseInt(first[2]!, 10) : 1, items });
  return i;
}

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const WORD = /[\p{L}\p{N}]/u;
const URL_RE = /^https?:\/\/[^\s<>]*[^\s<>.,:;!?'")\]]/;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => { if (text) { out.push({ t: "text", v: text }); text = ""; } };
  const push = (n: Inline) => { flush(); out.push(n); };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    const rest = src.slice(i);

    if (ch === "\\" && src[i + 1] === "\n") { push({ t: "br" }); i += 2; continue; }
    if (ch === "\\" && i + 1 < src.length && PUNCT.test(src[i + 1]!)) { text += src[i + 1]; i += 2; continue; }

    if (ch === "\n") {
      // Two trailing spaces make a hard break; otherwise a line break inside a paragraph is a space.
      if (text.endsWith("  ")) { text = text.replace(/ +$/, ""); push({ t: "br" }); } else text = text.replace(/ +$/, "") + " ";
      i++;
      continue;
    }

    if (ch === "`") {
      const run = /^`+/.exec(rest)![0];
      const close = src.indexOf(run, i + run.length);
      // The closing run must be exactly as long (not part of a longer run).
      let end = close;
      while (end !== -1 && src[end + run.length] === "`") end = src.indexOf(run, end + run.length + 1);
      if (end !== -1) {
        let v = src.slice(i + run.length, end).replace(/\n/g, " ");
        if (v.length > 1 && v.startsWith(" ") && v.endsWith(" ") && v.trim()) v = v.slice(1, -1);
        push({ t: "code", v });
        i = end + run.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }

    if (ch === "!" && src[i + 1] === "[") {
      // Images aren't loaded (their sources are arbitrary): the alt text stands in, linked like a link.
      const link = readLink(src, i + 1);
      if (link) { push({ t: "link", href: link.href, c: parseInline(link.text) }); i = link.end; continue; }
    }
    if (ch === "[") {
      const link = readLink(src, i);
      if (link) { push({ t: "link", href: link.href, c: parseInline(link.text) }); i = link.end; continue; }
    }
    if (ch === "<") {
      const auto = /^<(https?:\/\/[^\s<>]+|mailto:[^\s<>]+)>/.exec(rest);
      if (auto) { push({ t: "link", href: auto[1]!, c: [{ t: "text", v: auto[1]!.replace(/^mailto:/, "") }] }); i += auto[0].length; continue; }
    }
    if ((ch === "h") && (i === 0 || !WORD.test(src[i - 1]!))) {
      const url = URL_RE.exec(rest);
      if (url) { push({ t: "link", href: url[0], c: [{ t: "text", v: url[0] }] }); i += url[0].length; continue; }
    }

    if (ch === "~" && src[i + 1] === "~") {
      const span = readDelimited(src, i, "~~");
      if (span) { push({ t: "del", c: parseInline(span.inner) }); i = span.end; continue; }
    }
    if (ch === "*" || ch === "_") {
      const double = src[i + 1] === ch;
      const span = (double ? readDelimited(src, i, ch + ch) : null) ?? readDelimited(src, i, ch);
      if (span) { push({ t: span.delim.length === 2 ? "strong" : "em", c: parseInline(span.inner) }); i = span.end; continue; }
      // An unmatched run stays as text whole (so `**` doesn't become `*` + emphasis).
      const run = new RegExp(`^\\${ch}+`).exec(rest)![0];
      text += run;
      i += run.length;
      continue;
    }

    text += ch;
    i++;
  }
  flush();
  return out;
}

/** `[text](href)` at `at`: the text, the href and the index after it. */
function readLink(src: string, at: number): { text: string; href: string; end: number } | null {
  let depth = 0;
  let j = at;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === "\\") { j++; continue; }
    if (c === "`") { const close = src.indexOf("`", j + 1); if (close !== -1) j = close; continue; }
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) break;
  }
  if (j >= src.length || src[j + 1] !== "(") return null;
  const m = /^\(\s*(<[^>]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/.exec(src.slice(j + 1));
  if (!m) return null;
  return { text: src.slice(at + 1, j), href: m[1]!.replace(/^<|>$/g, ""), end: j + 1 + m[0].length };
}

/** An emphasis-like span opened by `delim` at `at`, with flanking rules so `snake_case` and `2 * 3 * 4` stay text. */
function readDelimited(src: string, at: number, delim: string): { inner: string; end: number; delim: string } | null {
  const after = src[at + delim.length];
  if (after === undefined || /\s/.test(after) || after === delim[0]) return null;
  const under = delim[0] === "_";
  if (under && at > 0 && WORD.test(src[at - 1]!)) return null;
  let j = at + delim.length;
  while (j < src.length) {
    const c = src[j]!;
    if (c === "\\") { j += 2; continue; }
    if (c === "`") {
      // Delimiters inside a code span don't close the emphasis.
      const run = /^`+/.exec(src.slice(j))![0];
      const close = src.indexOf(run, j + run.length);
      j = close === -1 ? j + run.length : close + run.length;
      continue;
    }
    if (c === delim[0]) {
      // A run of the delimiter closes this span when it's exactly as long, or three long (`***` ends `*…**…**`
      // and `**…*…*`: the span takes the run's last characters). Other runs belong to inner spans.
      const run = new RegExp(`^\\${c}+`).exec(src.slice(j))![0].length;
      const end = j + run;
      const close = end - delim.length;
      const next = src[end];
      if ((run === delim.length || run === 3) && close > at + delim.length && !/\s/.test(src[j - 1]!) && !(under && next !== undefined && WORD.test(next))) {
        return { inner: src.slice(at + delim.length, close), end, delim };
      }
      j = end;
      continue;
    }
    j++;
  }
  return null;
}

// ── DOM ──

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function inlineNodes(doc: Document, nodes: Inline[]): Node[] {
  return nodes.map((n): Node => {
    switch (n.t) {
      case "text": return doc.createTextNode(n.v);
      case "br": return el(doc, "br");
      case "code": { const c = el(doc, "code"); c.textContent = n.v; return c; }
      case "link": {
        const a = el(doc, "span", "md-link");
        a.title = n.href;
        a.append(...inlineNodes(doc, n.c));
        return a;
      }
      default: { const e = el(doc, n.t === "strong" ? "strong" : n.t === "em" ? "em" : "del"); e.append(...inlineNodes(doc, n.c)); return e; }
    }
  });
}

function blockNodes(doc: Document, blocks: Block[]): Node[] {
  return blocks.map((b): Node => {
    switch (b.t) {
      case "p": { const p = el(doc, "p"); p.append(...inlineNodes(doc, b.c)); return p; }
      case "h": { const hd = el(doc, `h${Math.min(6, b.level)}` as "h1"); hd.append(...inlineNodes(doc, b.c)); return hd; }
      case "hr": return el(doc, "hr");
      case "code": {
        const pre = el(doc, "pre");
        const code = el(doc, "code");
        if (b.lang) code.dataset.lang = b.lang;
        code.textContent = b.v;
        pre.append(code);
        return pre;
      }
      case "quote": { const q = el(doc, "blockquote"); q.append(...blockNodes(doc, b.c)); return q; }
      case "list": {
        const list = el(doc, b.ordered ? "ol" : "ul");
        if (b.ordered && b.start !== 1) (list as HTMLOListElement).start = b.start;
        for (const item of b.items) { const li = el(doc, "li"); li.append(...blockNodes(doc, item)); list.append(li); }
        return list;
      }
      case "table": {
        const wrap = el(doc, "div", "md-table");
        const table = el(doc, "table");
        const row = (cells: Inline[][], tag: "th" | "td") => {
          const tr = el(doc, "tr");
          cells.forEach((c, k) => { const cell = el(doc, tag); if (b.align[k]) cell.style.textAlign = b.align[k]!; cell.append(...inlineNodes(doc, c)); tr.append(cell); });
          return tr;
        };
        const thead = el(doc, "thead");
        thead.append(row(b.head, "th"));
        const tbody = el(doc, "tbody");
        for (const r of b.rows) tbody.append(row(r, "td"));
        table.append(thead, tbody);
        wrap.append(table);
        return wrap;
      }
    }
  });
}

/** Markdown as a `div.md` (styled by MARKDOWN_CSS). */
export function renderMarkdown(src: string, doc: Document = document): HTMLDivElement {
  const root = el(doc, "div", "md");
  root.append(...blockNodes(doc, parseMarkdown(src)));
  return root;
}

/** Styles for renderMarkdown's output, scoped under `.md`; uses the overlay's --ui-* colors. */
export const MARKDOWN_CSS = `
.md { overflow-wrap: anywhere; }
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md p, .md ul, .md ol, .md pre, .md blockquote, .md .md-table { margin: 0 0 6px; }
.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { margin: 8px 0 4px; font-weight: 600; line-height: 1.3; }
.md h1 { font-size: 15px; } .md h2 { font-size: 14px; } .md h3 { font-size: 13px; } .md h4, .md h5, .md h6 { font-size: 12px; }
.md ul, .md ol { padding-left: 18px; }
.md li > p, .md li > ul, .md li > ol { margin: 0; }
.md li + li { margin-top: 2px; }
.md code { font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--ui-field); border: 1px solid var(--ui-line); border-radius: 4px; padding: 0 3px; }
.md pre { padding: 6px 8px; overflow-x: auto; background: var(--ui-field); border: 1px solid var(--ui-line); border-radius: 6px; white-space: pre; }
.md pre code { background: none; border: 0; padding: 0; white-space: inherit; }
.md blockquote { padding-left: 8px; border-left: 2px solid var(--ui-line); color: var(--ui-muted); }
.md hr { border: 0; border-top: 1px solid var(--ui-line); margin: 8px 0; }
.md .md-table { overflow-x: auto; }
.md table { border-collapse: collapse; font-size: 11.5px; }
.md th, .md td { border: 1px solid var(--ui-line); padding: 2px 6px; text-align: left; vertical-align: top; }
.md th { font-weight: 600; background: var(--ui-field); }
.md .md-link { color: var(--ui-accent); text-decoration: underline dotted; text-underline-offset: 2px; cursor: help; }
`;
