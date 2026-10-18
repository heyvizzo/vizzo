// React component info for a pointed-at element, read from React's dev-mode fiber on the DOM node: the components
// above it, the nearest one's props, and where its JSX was written. The fiber lives in the page's own JavaScript world,
// which the page preload (an isolated world) can't see, so the preload runs this function in the page's world with
// webFrame.executeJavaScript(`(${reactInfo})(el)`). It must stay self-contained: no imports, no outside helpers.
import type { ReactInfo } from "../../shared/protocol.ts";

export function reactInfo(el: Element | null): ReactInfo | null {
  const CHAIN_MAX = 8;
  const PROPS_MAX = 400;
  if (!el) return null;
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
  type Fiber = { tag: number; type: any; return: Fiber | null; memoizedProps?: Record<string, unknown>; _debugSource?: { fileName: string; lineNumber: number; columnNumber?: number }; _debugStack?: { stack?: string }; _debugOwner?: Fiber | null };
  const host = key ? (el as unknown as Record<string, Fiber>)[key] : undefined;
  if (!host) return null;

  // A production build has no debug fields and minified function names: only explicit displayNames mean anything there.
  const dev = "_debugOwner" in host || "_debugSource" in host || "_debugStack" in host;
  const nameOf = (t: any): string | null => {
    if (!t || typeof t === "string") return null;
    if (typeof t === "function") return t.displayName || (dev ? t.name : null) || null;
    if (typeof t === "object") return t.displayName || nameOf(t.render) || nameOf(t.type) || null; // forwardRef, memo
    return null;
  };
  // Function, class, forwardRef, memo and simple-memo components.
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);

  const chain: string[] = [];
  let nearest: Fiber | null = null;
  for (let f: Fiber | null = host.return; f && chain.length < CHAIN_MAX; f = f.return) {
    if (!COMPONENT_TAGS.has(f.tag)) continue;
    const name = nameOf(f.type);
    if (!name || name.length < 3) continue; // anonymous or minified
    if (chain[chain.length - 1] === name) continue; // memo(forwardRef(X)) shows up twice
    chain.push(name);
    nearest ??= f;
  }
  if (!chain.length) return null;

  const show = (v: unknown): string => {
    if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean") return String(v);
    if (typeof v === "string") return JSON.stringify(v.length > 40 ? `${v.slice(0, 39)}…` : v);
    if (typeof v === "function") return "ƒ";
    if (Array.isArray(v)) return `[${v.length} items]`;
    if (typeof v === "object" && (v as { $$typeof?: unknown }).$$typeof) return "<element>";
    if (typeof v === "object") {
      const keys = Object.keys(v as object);
      return `{${keys.slice(0, 5).join(", ")}${keys.length > 5 ? ", …" : ""}}`;
    }
    return typeof v;
  };
  let props: string | undefined;
  const p = nearest?.memoizedProps;
  if (p && typeof p === "object") {
    const parts = Object.keys(p).filter((k) => k !== "children").map((k) => `${k}: ${show(p[k])}`);
    const s = parts.join(", ");
    if (s) props = s.length > PROPS_MAX ? `${s.slice(0, PROPS_MAX - 1)}…` : s;
  }

  // Where the element's JSX was written. React ≤18: _debugSource (exact). React 19: the stack captured when the JSX
  // ran; its first frame outside React and node_modules is the component's module as the dev server serves it.
  let source: string | undefined;
  let sourceExact = false;
  const ds = host._debugSource;
  if (ds?.fileName) {
    source = `${ds.fileName}:${ds.lineNumber}`;
    sourceExact = true;
  } else {
    const stack = host._debugStack?.stack ?? "";
    for (const line of stack.split("\n").slice(1)) {
      const m = /\(?((?:https?|file):\/\/[^\s)]+?):(\d+):\d+\)?\s*$/.exec(line);
      if (!m || /node_modules|\/\.vite\/deps\/|react-dom|react_jsx/.test(m[1]!)) continue;
      let file = m[1]!.replace(/[?#].*$/, "");
      // Vite: `/resources/js/x.tsx` is relative to the project root; `/@fs/Users/…` is an absolute path.
      try { const path = new URL(file).pathname; file = path.startsWith("/@fs/") ? path.slice(4) : path.slice(1); } catch { /* keep the URL */ }
      source = `${file}:${m[2]}`;
      break;
    }
  }

  return { chain, ...(props ? { props } : {}), ...(source ? { source, sourceExact } : {}), ...(dev ? {} : { production: true }) };
}
