import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { startWebServer, staticPath } from "./webServer.ts";

const closers: (() => void)[] = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

describe("staticPath", () => {
  it("maps URL paths under the root, / to index.html, and refuses ones that climb out", () => {
    expect(staticPath("/app/dist", "/chat.html?x=1")).toBe("/app/dist/chat.html");
    expect(staticPath("/app/dist", "/")).toBe("/app/dist/index.html");
    expect(staticPath("/app/dist", "/assets/a%20b.js")).toBe("/app/dist/assets/a b.js");
    expect(staticPath("/app/dist", "/../secret")).toBeNull();
    expect(staticPath("/app/dist", "/%2e%2e/secret")).toBeNull();
    expect(staticPath("/app/dist", "/%E0%A4%A")).toBeNull();
  });
});

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "web-server-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "chat.html"), "<p>chat</p>");
  writeFileSync(join(root, "assets/app.js"), "console.log(1)");
  // The voice server: an /api route and a /ws echo.
  const backend = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => { res.writeHead(201, { "content-type": "application/json" }); res.end(JSON.stringify({ method: req.method, url: req.url, body })); });
  });
  const wss = new WebSocketServer({ server: backend, path: "/ws" });
  wss.on("connection", (ws) => ws.on("message", (m) => ws.send(`echo ${m}`)));
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const backendPort = (backend.address() as { port: number }).port;
  const web = await startWebServer(root, backendPort);
  closers.push(() => { web.server.close(); wss.close(); backend.close(); rmSync(root, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${web.port}`, ws: `ws://127.0.0.1:${web.port}/ws` };
}

describe("startWebServer", () => {
  it("serves the built pages with their types", async () => {
    const { base } = await setup();
    const page = await fetch(`${base}/chat.html`);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(await page.text()).toBe("<p>chat</p>");
    expect((await fetch(`${base}/assets/app.js`)).headers.get("content-type")).toMatch(/javascript/);
    expect((await fetch(`${base}/missing.html`)).status).toBe(404);
  });

  it("passes /api requests (method, query, body, status) to the voice server", async () => {
    const { base } = await setup();
    const r = await fetch(`${base}/api/speech/install?x=1`, { method: "POST", body: '{"a":1}' });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ method: "POST", url: "/api/speech/install?x=1", body: '{"a":1}' });
  });

  it("answers 502 while the voice server isn't running", async () => {
    const root = mkdtempSync(join(tmpdir(), "web-server-"));
    const web = await startWebServer(root, 1); // nothing listens on port 1
    closers.push(() => { web.server.close(); rmSync(root, { recursive: true, force: true }); });
    expect((await fetch(`http://127.0.0.1:${web.port}/api/tts/voices`)).status).toBe(502);
  });

  it("carries the /ws WebSocket both ways", async () => {
    const { ws: url } = await setup();
    const ws = new WebSocket(url);
    await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
    const reply = new Promise<string>((r) => ws.once("message", (m) => r(String(m))));
    ws.send("hi");
    expect(await reply).toBe("echo hi");
    ws.close();
  });
});
