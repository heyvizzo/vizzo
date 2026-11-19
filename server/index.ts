import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { Session, type SessionOpts } from "./session.ts";
import { warmStatus } from "./adapters/warmPool.ts";
import type { Orchestrator } from "./orchestrators/types.ts";
import type { RunConfig } from "../shared/config.ts";
import type { ServerMsg } from "../shared/protocol.ts";
import { readChangesPreferences } from "../electron/settings.ts";
import { changesService } from "./changes/changesService.ts";
import { changeRoutes, isLocalChangesRequest, subscribeChangesStatus, type ChangesHttpOptions } from "./changes/http.ts";
import { projectFile, watchProject } from "./project.ts";
import { watchMemory } from "./memory.ts";
import { threadStore } from "./threads/store.ts";

export interface StartServerOpts {
  /** Override the approach → orchestrator table (smoke:e2e --fake). */
  orchestrators?: Partial<Record<RunConfig["approach"], Orchestrator>>;
  /** Append runs to results/*.jsonl (default true). */
  persist?: boolean;
  quiet?: boolean;
  /** Interface to listen on (default: all). The Electron shell uses 127.0.0.1. */
  host?: string;
  /** Source-control service and native provider overrides used by the HTTP integration tests. */
  changes?: ChangesHttpOptions;
  /** Read the current source-control preference. Electron and the CLI use the saved desktop preference. */
  sourceControlEnabled?: () => boolean;
  threadDeps?: SessionOpts["threadDeps"];
}

export interface RunningServer { port: number; refreshSourceControl(): void; close(): Promise<void> }

/** Start the HTTP + /ws server. Port 0 picks a free port. */
export function startServer(port: number, opts: StartServerOpts = {}): Promise<RunningServer> {
  const log = opts.quiet ? () => {} : (...a: unknown[]) => console.log(...a);
  const changes = opts.changes?.service ?? changesService();
  const handleChanges = changeRoutes(changes, opts.changes);
  const readSourceControlEnabled = opts.sourceControlEnabled ?? (() => readChangesPreferences().gitSourceControl);
  let sourceControlEnabled = readSourceControlEnabled();
  let revision = 0;
  const sourceControlRevision = (): number | null => {
    const enabled = readSourceControlEnabled();
    if (enabled !== sourceControlEnabled) {
      sourceControlEnabled = enabled;
      revision++;
    }
    return enabled ? revision : null;
  };
  // Open event streams (one per browser tab) that get a line whenever a demo file is saved.
  const streams = new Set<ServerResponse>();
  const stopWatch = watchProject((file) => {
    for (const r of streams) r.write(`data: ${JSON.stringify({ file })}\n\n`);
  });
  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/changes" || url.pathname.startsWith("/api/changes/")) {
      const start = sourceControlRevision();
      return handleChanges(req, res, url, () => start !== null && sourceControlRevision() === start);
    }
    if (req.method === "POST" && (url.pathname === "/api/sessions/release" || url.pathname === "/api/sessions/continue")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      let sessionId: unknown;
      let context: unknown;
      try { ({ sessionId, context } = JSON.parse(body)); } catch { /* invalid below */ }
      if (typeof sessionId !== "string" || !sessionId) { res.writeHead(400); return res.end(); }
      try {
        if (url.pathname === "/api/sessions/continue") {
          const { continueConversationSession } = await import("./centralSession.ts");
          if (threadStore().turnsBlocked) throw new Error("Thread changes are still being saved.");
          continueConversationSession(sessionId, typeof context === "string" ? context.slice(0, 32_000) : undefined);
        } else {
          const { releaseSessionForResume } = await import("./sessionResume.ts");
          await releaseSessionForResume(sessionId);
        }
        res.writeHead(204);
        return res.end();
      } catch (e) {
        res.writeHead(409, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
    }
    if (req.method === "GET" && url.pathname === "/api/project/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": connected\n\n");
      streams.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => { clearInterval(ping); streams.delete(res); });
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/project/")) {
      let name = "";
      try { name = decodeURIComponent(url.pathname.slice("/api/project/".length)); } catch { /* malformed → 404 */ }
      const file = await projectFile(name);
      if (!file) return res.writeHead(404).end();
      res.writeHead(200, { "content-type": file.type, "cache-control": "no-cache" });
      return res.end(file.body);
    }
    if (req.method === "GET" && url.pathname === "/api/tts/voices") {
      const { ttsVoices } = await import("./ttsVoices.ts");
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(ttsVoices()));
    }
    if (req.method === "GET" && url.pathname === "/api/llm/providers") {
      const { providerStatus } = await import("./llmProviders.ts");
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(providerStatus()));
    }
    if (req.method === "GET" && url.pathname === "/api/llm/models") {
      const { isProvider, providerModels } = await import("./llmProviders.ts");
      const id = url.searchParams.get("provider") ?? "";
      if (!isProvider(id)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(await providerModels(id)));
    }
    if (req.method === "POST" && url.pathname === "/api/llm/scan") {
      const { scanHarnesses } = await import("./llmProviders.ts");
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(await scanHarnesses()));
    }
    if (url.pathname === "/api/traces" || url.pathname === "/api/traces/reveal") {
      // The local trace log (Settings → Debugging → Traces): what's saved (GET), delete it all (DELETE), open its folder.
      const { deleteTraces, traceDir, traceStatus } = await import("./traceStore.ts");
      if (url.pathname === "/api/traces/reveal" && req.method === "POST") {
        const { mkdirSync } = await import("node:fs");
        const { spawn } = await import("node:child_process");
        mkdirSync(traceDir(), { recursive: true });
        spawn("open", [traceDir()], { stdio: "ignore", detached: true }).unref();
        res.writeHead(204);
        return res.end();
      }
      if (req.method === "DELETE") deleteTraces();
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(traceStatus()));
    }
    if (url.pathname === "/api/llm/notice") {
      // What the one-time move to the new switch defaults turned on (null: nothing to say). POST: seen.
      const { dismissSelectionNotice, selectionNotice } = await import("./llmSelection.ts");
      if (req.method === "POST") dismissSelectionNotice();
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(req.method === "POST" ? null : selectionNotice()));
    }
    if (url.pathname === "/api/llm/selection") {
      const { settledSelection, setSelection } = await import("./llmSelection.ts");
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        let sel;
        try { sel = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(setSelection(sel)));
      }
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(await settledSelection()));
      }
    }
    // On-device speech engines: the selected Voice / Speech models (POST: switch, which kills the old helper and
    // starts the new one) and their state and RAM (GET; the Settings page polls it).
    if (url.pathname === "/api/speech/selection" && req.method === "POST") {
      const { setSpeech, speechEngineStates } = await import("./speechEngines.ts");
      let body = "";
      for await (const chunk of req) body += chunk;
      let sel;
      try { sel = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
      const selection = setSpeech(sel);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ selection, engines: await speechEngineStates() }));
    }
    if (url.pathname === "/api/speech/engines" && req.method === "GET") {
      const { currentSpeech, speechEngineStates } = await import("./speechEngines.ts");
      const { speechInstaller } = await import("./speechInstall.ts");
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ selection: currentSpeech(), engines: await speechEngineStates(), installs: speechInstaller().states() }));
    }
    // Settings' Install / Cancel / Uninstall for an on-device engine, and the download of one more voice (a picked
    // Piper voice that isn't there). Body: { kind, engine, action, voice?, installUv? }. Answers with
    // every engine's install state (or 400 and the reason, e.g. uninstalling one that's installing).
    if (url.pathname === "/api/speech/install" && req.method === "POST") {
      const { speechInstaller, UvRequiredError } = await import("./speechInstall.ts");
      let body = "";
      for await (const chunk of req) body += chunk;
      const installer = speechInstaller();
      try {
        const { kind, engine, action, voice, installUv } = JSON.parse(body) as { kind: string; engine: string; action: string; voice?: string; installUv?: boolean };
        if (action === "install") installer.install(kind, engine, installUv === true);
        else if (action === "install-voice") installer.installVoice(kind, engine, String(voice));
        else if (action === "cancel-voice") installer.cancelVoice(kind, engine, String(voice));
        else if (action === "cancel") installer.cancel(kind, engine);
        else if (action === "uninstall") installer.uninstall(kind, engine);
        else throw new Error(`unknown action ${action}`);
      } catch (e) {
        res.writeHead(e instanceof UvRequiredError ? 409 : 400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e),
          ...(e instanceof UvRequiredError ? { missingDependency: "uv" } : {}), installs: installer.states() }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ installs: installer.states() }));
    }
    // Transcribe a clip with an on-device STT model, outside any turn (queued feedback, Instant off). Body: PCM16 mono
    // 24 kHz. Only the free local models: a paid one would bill for audio that's transcribed again when it's sent.
    if (req.method === "POST" && url.pathname === "/api/stt/transcribe") {
      const { isLocalStt } = await import("../shared/config.ts");
      const model = url.searchParams.get("model") ?? "";
      const language = url.searchParams.get("language") ?? "";
      if (!isLocalStt(model as never)) { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "only on-device models" })); }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const { openStt } = await import("./orchestrators/deps.ts");
      let stt;
      try {
        stt = await openStt({ mark: () => {}, model: model as never, ...(language && language !== "auto" ? { language } : {}) });
        stt.pushAudio(Buffer.concat(chunks));
        stt.commit();
        const r = await stt.final();
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      } finally {
        stt?.close();
      }
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        ok: true,
        keys: {
          warmAgents: warmStatus(),
          openai: !!process.env.OPENAI_API_KEY,
          elevenlabs: !!process.env.ELEVENLABS_API_KEY,
          elevenVoice: !!process.env.ELEVENLABS_VOICE_ID,
        },
      }));
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server: http, path: "/ws" });
  const changesClients = new Set<WebSocket>();
  const changesWatchers = new Set<WebSocket>();
  const unsubscribeChanges = subscribeChangesStatus(changes, (status) => {
    if (sourceControlRevision() === null) return;
    const event: ServerMsg = status.kind === "ready"
      ? { type: "changes.updated", project: status.project, generation: status.generation }
      : { type: "changes.status", status };
    const message = JSON.stringify(event);
    for (const client of changesClients) if (client.readyState === client.OPEN) client.send(message);
  });
  // ws re-emits the HTTP server's errors (e.g. EADDRINUSE); startServer's promise reports them instead.
  wss.on("error", () => {});
  wss.on("connection", (ws, req) => {
    log("[ws] connected");
    const watcher = new URL(req.url ?? "/", "http://localhost").searchParams.get("view") === "changes";
    const local = isLocalChangesRequest(req);
    if (watcher && !local) { ws.close(1008, "Source control requires the local Vizzo window"); return; }
    if (watcher && sourceControlRevision() === null) { ws.close(1008, "Git source control is disabled"); return; }
    if (watcher) changesWatchers.add(ws);
    else new Session(ws, {
      orchestrators: opts.orchestrators, persist: opts.persist, threadDeps: opts.threadDeps,
      changes: local ? changes : undefined, sourceControlRevision,
    });
    if (local) changesClients.add(ws);
    ws.on("close", () => { changesClients.delete(ws); changesWatchers.delete(ws); log("[ws] closed"); });
  });

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      unsubscribeChanges();
      stopWatch();
      reject(error);
    };
    http.once("error", onError);
    http.listen(port, opts.host, () => {
      http.off("error", onError);
      const addr = http.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      log(`[server] http://localhost:${actual}  ws://localhost:${actual}/ws`);
      watchMemory();
      resolve({
        port: actual,
        refreshSourceControl: () => {
          // A disable/re-enable can occur between server requests. Main reports every saved toggle.
          revision++;
          for (const ws of changesWatchers) {
            changesClients.delete(ws);
            ws.close(1008, "Git source control preference changed");
          }
        },
        close: () => new Promise<void>((res) => {
          for (const c of wss.clients) c.terminate();
          for (const r of streams) r.end();
          stopWatch();
          unsubscribeChanges();
          wss.close();
          http.close(() => res());
        }),
      });
    });
  });
}
