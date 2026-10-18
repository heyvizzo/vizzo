import { describe, expect, it } from "vitest";
import { reactInfo } from "./reactInfo.ts";

const fiber = (tag: number, type: unknown, parent: object | null, extra: object = {}) => ({ tag, type, return: parent, ...extra });

function page(hostExtra: object) {
  function Inertia() {}
  function SchemaMigrations() {}
  const HeaderMeta = Object.assign(() => null, { displayName: "HeaderMeta" });
  const root = fiber(3, null, null);
  const inertia = fiber(0, Inertia, root);
  const pageF = fiber(0, SchemaMigrations, inertia);
  const memo = fiber(14, { type: function PageHeader() {} }, pageF);
  const anon = fiber(0, () => null, memo); // anonymous: skipped
  const meta = fiber(0, HeaderMeta, anon, { memoizedProps: { role: "owner", ceiling: 200, onChange() {}, items: [1, 2], children: "x" } });
  const div = fiber(5, "div", meta);
  const host = fiber(5, "span", div, hostExtra);
  return { "__reactFiber$abc": host } as unknown as Element;
}

describe("reactInfo", () => {
  it("returns null without a fiber", () => {
    expect(reactInfo({} as Element)).toBeNull();
    expect(reactInfo(null)).toBeNull();
  });

  it("React 18: chain, props and the exact _debugSource", () => {
    const info = reactInfo(page({ _debugSource: { fileName: "/app/resources/js/Pages/SchemaMigrations.tsx", lineNumber: 42 } }));
    expect(info).toEqual({
      chain: ["HeaderMeta", "PageHeader", "SchemaMigrations", "Inertia"],
      props: 'role: "owner", ceiling: 200, onChange: ƒ, items: [2 items]',
      source: "/app/resources/js/Pages/SchemaMigrations.tsx:42",
      sourceExact: true,
    });
  });

  it("React 19: the first app frame of _debugStack, as a project path", () => {
    const stack = [
      "Error: react-stack-top-frame",
      "    at exports.jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:250:30)",
      "    at HeaderMeta (http://localhost:5173/resources/js/Components/HeaderMeta.tsx?t=17:31:9)",
    ].join("\n");
    expect(reactInfo(page({ _debugStack: { stack } }))).toMatchObject({ source: "resources/js/Components/HeaderMeta.tsx:31", sourceExact: false });
    const fs = stack.replace("http://localhost:5173/resources", "http://localhost:5173/@fs/Users/j/app/resources");
    expect(reactInfo(page({ _debugStack: { stack: fs } }))?.source).toBe("/Users/j/app/resources/js/Components/HeaderMeta.tsx:31");
  });

  it("production build: only explicit displayNames, flagged", () => {
    // No debug fields on the fiber: minified function names are ignored, explicit displayNames kept.
    expect(reactInfo(page({}))).toMatchObject({ chain: ["HeaderMeta"], production: true });
    expect(reactInfo(page({}))?.source).toBeUndefined();
  });

  it("is self-contained: runs from its source text alone", () => {
    const fn = new Function(`return (${reactInfo.toString()})`)() as typeof reactInfo;
    expect(fn(page({ _debugOwner: null }))?.chain).toEqual(["HeaderMeta", "PageHeader", "SchemaMigrations", "Inertia"]);
  });
});
