import { setAgentFactory, stopWarm } from "./warmPool.ts";
import { afterEach, describe, expect, it } from "vitest";
import { parseClientMsg } from "../../shared/protocol.ts";
import { DEFAULT_CONFIG } from "../../shared/config.ts";
import { anthropicContent, assertDrawingVision, codexInput, drawingContext, redactImagePayloads, openaiContent, opencodeParts, rpcImages } from "./drawing.ts";
import { routeTurn, solveTask, setLogger } from "./claude.ts";
import { apiRequest, setAnthropicFactory, setApiFetch } from "./llmApi.ts";

import { annotation } from "./drawing.fixture.ts";


describe("drawing model serializers", () => {
  it("uses each transport's native image payload and preserves text-only requests", () => {
    expect(codexInput("change", [annotation])).toEqual([{ type: "text", text: "change", text_elements: [] }, { type: "image", url: annotation.image.dataUrl }]);
    expect(rpcImages([annotation])).toEqual([{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
    expect(opencodeParts("change", [annotation])[1]).toMatchObject({ type: "file", mime: "image/png", url: annotation.image.dataUrl });
    expect(anthropicContent("change", [annotation])).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }, { type: "text", text: "change" }]);
    expect(openaiContent("change", [annotation])).toEqual([{ type: "text", text: "change" }, { type: "image_url", image_url: { url: annotation.image.dataUrl } }]);
    expect(anthropicContent("change")).toBe("change");
    expect(openaiContent("change")).toBe("change");
  });
  it("fails clearly when a harness model cannot accept images or cannot advertise the capability", () => {
    expect(() => assertDrawingVision(false, "pi", "text-only")).toThrow("does not support drawing images");
    expect(() => assertDrawingVision(undefined, "OpenCode", "custom")).toThrow("has not advertised support");
    expect(() => assertDrawingVision(true, "omp", "vision")).not.toThrow();
  });
  it("redacts echoed image blocks in inspector responses", () => {
    const raw = { content: [{ type: "image", url: annotation.image.dataUrl }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }], usage: { input_tokens: 4 } };
    const inspected = redactImagePayloads(raw);
    expect(JSON.stringify(inspected)).not.toContain("aGVsbG8=");
    expect(inspected).toMatchObject({ usage: { input_tokens: 4 } });
    expect(raw.content[0]!.url).toBe(annotation.image.dataUrl);
  });
  it("describes captured geometry and references without image bytes", () => {
    const context = drawingContext(annotation);
    expect(context).toContain("scroll (0,20)");
    expect(context).toContain("from (10,20) to (30,40)");
    expect(context).toContain("Button.tsx:12");
    expect(context).not.toContain("base64");
    expect(context).not.toContain("aGVsbG8=");
  });
  it("rejects malformed annotations at websocket ingress", () => {
    const start = { type: "turn.start", turnId: "t", config: DEFAULT_CONFIG, tPress: 0, text: "change", annotation };
    expect(parseClientMsg(JSON.stringify(start))).toEqual(start);
    expect(parseClientMsg(JSON.stringify({ ...start, annotation: { ...annotation, image: { ...annotation.image, dataUrl: "invalid" } } }))).toBeNull();
  });
});

describe("drawing delivery on the fast API", () => {
  const key = process.env.OPENAI_API_KEY;
  afterEach(() => { setApiFetch(null); setAgentFactory(null); stopWarm(); if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key; });
  it("resends the latest four distinct central drawings on router follow-ups and solver requests", async () => {
    process.env.OPENAI_API_KEY = "test";
    const history = Array.from({ length: 6 }, (_, i) => ({ turnId: `t${i}`, approach: "pipeline" as const, user: "move these", assistant: "done", detail: "", annotation: { ...annotation, id: `d${i}` } }));
    history.push(history.at(-1)!); // A completed background result can refer to the same drawing twice.
    let body: any;
    setApiFetch((async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ intent: "answer", estimate_seconds: null, say: "done", question: "" }) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    }) as typeof fetch);
    await routeTurn({ mark() {}, transcript: "move them further", pointing: [], mode: "auto", history, llm: { provider: "openai", model: "gpt-4.1" }, onSpokenDelta() {} });
    expect(body.messages.at(-1).content.filter((p: any) => p.type === "image_url")).toHaveLength(4);
    expect(body.messages.at(-1).content[0].text).toContain("Attached images, in order: d2, d3, d4, d5");
    expect(body.messages[0].content).not.toContain("base64");
    let sent: readonly { id: string }[] = [];
    setAgentFactory(() => ({ alive: () => true, ready: () => true, kill() {}, async request(_user, onText, _timeout, annotations) {
      sent = annotations ?? [];
      onText?.("SPOKEN: Done.\n\nMoved them.");
      return { text: "SPOKEN: Done.\n\nMoved them.", model: "test", usage: {}, stopReason: "end_turn", raw: null, warm: true };
    } }));
    await solveTask({ mark() {}, question: "move them further", pointing: [], fast: false, history, onSpokenLine() {}, onDelta() {}, llm: { provider: "codex", model: "test" } });
    expect(sent.map(a => a.id)).toEqual(["d2", "d3", "d4", "d5"]);
  });
  it("sends actual image content while prompt inspection contains only geometry and attachment summary", async () => {
    process.env.OPENAI_API_KEY = "test";
    setLogger(() => {});
    let body: any;
    setApiFetch((async (_url, init) => {
      body = JSON.parse(String(init?.body));
      const answer = JSON.stringify({ intent: "answer", estimate_seconds: null, say: "The arrow points to Save.", question: "" });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch);
    let inspector = "";
    await routeTurn({ mark() {}, transcript: "What does the arrow point to?", pointing: [], mode: "auto", annotation,
      llm: { provider: "openai", model: "gpt-4.1" }, onSpokenDelta() {}, onPrompt: p => { inspector = JSON.stringify(p); } });
    const current = body.messages.at(-1);
    expect(current.content[1]).toEqual({ type: "image_url", image_url: { url: annotation.image.dataUrl } });
    expect(current.content[0].text).toContain("drawing-test");
    expect(inspector).toContain("attachments");
    expect(inspector).not.toContain("aGVsbG8=");
  });
});


describe("drawing delivery on Anthropic", () => {
  const key = process.env.ANTHROPIC_API_KEY;
  afterEach(() => { setAnthropicFactory(null); if (key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = key; });
  it("sends Messages image source blocks alongside the current user text", async () => {
    process.env.ANTHROPIC_API_KEY = "test";
    let request: any;
    setAnthropicFactory(() => ({ messages: { stream: (p: unknown) => {
      request = p;
      return { on() { return this; }, async finalMessage() { return { id: "test", model: "claude-test", stop_reason: "end_turn", usage: {} }; } };
    } } } as never));
    await apiRequest("anthropic", { provider: "anthropic", model: "claude-test" }, { system: "test", messages: [{ role: "user", content: "change" }], annotations: [annotation] }, undefined, 1000);
    expect(request.messages[0].content).toEqual(anthropicContent("change", [annotation]));
  });
});
