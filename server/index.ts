import "dotenv/config";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { Session } from "./session.ts";
import { loadRuns } from "./results.ts";
import { listFixtureFiles, readFixtureFile } from "./fixtureFiles.ts";

const PORT = Number(process.env.PORT ?? 8787);

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/api/results") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(await loadRuns()));
  }
  if (req.method === "GET" && url.pathname === "/api/fixtures") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(await listFixtureFiles()));
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/fixtures/")) {
    let name = "";
    try { name = decodeURIComponent(url.pathname.slice("/api/fixtures/".length)); } catch { /* malformed → 404 */ }
    const file = await readFixtureFile(name);
    if (!file) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": file.type, "cache-control": "no-cache" });
    return res.end(file.data);
  }
  if (req.method === "GET" && url.pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({
      ok: true,
      keys: {
        anthropic: !!process.env.ANTHROPIC_API_KEY,
        openai: !!process.env.OPENAI_API_KEY,
        elevenlabs: !!process.env.ELEVENLABS_API_KEY,
        elevenVoice: !!process.env.ELEVENLABS_VOICE_ID,
      },
    }));
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server: http, path: "/ws" });
wss.on("connection", (ws) => {
  console.log("[ws] connected");
  new Session(ws);
  ws.on("close", () => console.log("[ws] closed"));
});

http.listen(PORT, () => console.log(`[server] http://localhost:${PORT}  ws://localhost:${PORT}/ws`));
