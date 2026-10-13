import "dotenv/config";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { Session } from "./session.ts";
import { claudeProvider, hasClaudeCredentials } from "./adapters/claude.ts";
import { agentStatus } from "./adapters/claudeCli.ts";
import { loadRuns } from "./results.ts";
import type { Orchestrator } from "./orchestrators/types.ts";
import type { RunConfig } from "../shared/config.ts";
import { listFixtureFiles, readFixtureFile } from "./fixtureFiles.ts";

export interface StartServerOpts {
  /** Override the approach → orchestrator table (smoke:e2e --fake). */
  orchestrators?: Partial<Record<RunConfig["approach"], Orchestrator>>;
  /** Append runs to results/*.jsonl (default true). */
  persist?: boolean;
  quiet?: boolean;
}

export interface RunningServer { port: number; close(): Promise<void> }

/** Start the HTTP + /ws server. Port 0 picks a free port. */
export function startServer(port: number, opts: StartServerOpts = {}): Promise<RunningServer> {
  const log = opts.quiet ? () => {} : (...a: unknown[]) => console.log(...a);
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
          claude: hasClaudeCredentials(),
          claudeAgents: agentStatus(),
          claudeProvider: claudeProvider(),
          openai: !!process.env.OPENAI_API_KEY,
          elevenlabs: !!process.env.ELEVENLABS_API_KEY,
          elevenVoice: !!process.env.ELEVENLABS_VOICE_ID,
        },
      }));
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server: http, path: "/ws" });
  // ws re-emits the HTTP server's errors (e.g. EADDRINUSE); startServer's promise reports them instead.
  wss.on("error", () => {});
  wss.on("connection", (ws) => {
    log("[ws] connected");
    new Session(ws, { orchestrators: opts.orchestrators, persist: opts.persist });
    ws.on("close", () => log("[ws] closed"));
  });

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, () => {
      const addr = http.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      log(`[server] http://localhost:${actual}  ws://localhost:${actual}/ws`);
      resolve({
        port: actual,
        close: () => new Promise<void>((res) => {
          for (const c of wss.clients) c.terminate();
          wss.close();
          http.close(() => res());
        }),
      });
    });
  });
}

// `npm run dev:server` / `tsx server/index.ts`: listen on PORT (default 8787).
// FAKE_VENDORS=1: every vendor is faked (tones, canned text) so the UI can be tried without keys. Runs aren't saved.
async function fakeVendorOpts(): Promise<StartServerOpts> {
  const { createFakeDeps, REALISTIC_TIMING } = await import("./orchestrators/fakes.ts");
  const { createRealtimeOrchestrator } = await import("./orchestrators/realtime.ts");
  const { createPipelineOrchestrator } = await import("./orchestrators/pipeline.ts");
  const { createHybridOrchestrator } = await import("./orchestrators/hybrid.ts");
  const { createCursorOnlyOrchestrator } = await import("./orchestrators/cursorOnly.ts");
  const deps = () => createFakeDeps(REALISTIC_TIMING);
  console.log("[server] FAKE_VENDORS=1: using fake adapters, runs are not persisted");
  return {
    persist: false,
    orchestrators: {
      realtime: createRealtimeOrchestrator(deps()),
      pipeline: createPipelineOrchestrator(deps()),
      hybrid: createHybridOrchestrator(deps()),
      "cursor-only": createCursorOnlyOrchestrator(deps().openScribe),
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT ?? 8787);
  const opts = process.env.FAKE_VENDORS === "1" ? await fakeVendorOpts() : {};
  try {
    await startServer(port, opts);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EADDRINUSE") {
      console.error(`[server] port ${port} is already in use: another dev server is probably still running.`);
      console.error(`[server] find it with: lsof -nP -iTCP:${port} -sTCP:LISTEN   (or start this one with PORT=<other port>)`);
    } else {
      console.error("[server] failed to start", err);
    }
    process.exit(1);
  }
  // `npm run dev`: spawn the pre-warmed claude -p agents (router, progress lines, Opus) once the server is up.
  // CLAUDE_AGENTS=0 skips them.
  if (process.env.FAKE_VENDORS !== "1" && process.env.CLAUDE_AGENTS !== "0") {
    const { startClaudeAgents } = await import("./adapters/claudeCli.ts");
    await import("./adapters/claude.ts"); // registers the agents' prompts/models
    startClaudeAgents();
  }
  // On-device TTS engines (macOS, Kokoro, Piper): started now so each has its model loaded and voices
  // warmed before the first turn. LOCAL_TTS=0 skips them; one that isn't installed logs why and is skipped.
  if (process.env.FAKE_VENDORS !== "1" && process.platform === "darwin" && process.env.LOCAL_TTS !== "0") {
    const { LOCAL_ENGINES, startLocalTts } = await import("./adapters/localTts.ts");
    for (const engine of LOCAL_ENGINES) startLocalTts(engine).catch(() => {});
  }
}
