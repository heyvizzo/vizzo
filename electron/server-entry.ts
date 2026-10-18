// Runs in an Electron utilityProcess: the voice server, started the same way `npm run dev:server` starts it.
// The web app is served by Vite (see electron/main.ts), so this process only serves /api and /ws.
// The main process sends { type: "project", dir } when the user picks a folder: the server then works in that
// folder and restarts its warm agents there. { type: "page", url } is the browser pane's current URL.
// { type: "env", env } replaces the API keys (Settings) and restarts the warm agents so they inherit them.
import { startServer } from "../server/index.ts";
import { projectDir, setProjectDir } from "../server/project.ts";
import { warmSaved } from "../server/llmSelection.ts";
import { stopWarm } from "../server/adapters/warmPool.ts";
import { loadPriceCatalog } from "../server/prices.ts";
import { startSavedSpeech } from "../server/speechEngines.ts";
import { setBrowserUrl } from "../server/browserPage.ts";
import { applyEnv } from "./settings.ts";
import "../server/adapters/claude.ts"; // registers the roles' prompts

function useProject(dir: string | null) {
  setProjectDir(dir);
  // The solver's agents start in the project folder: re-warm (the old ones are killed).
  warmSaved();
  console.log(`[server] project folder: ${projectDir() ?? "(none)"}`);
}

const running = await startServer(Number(process.env.PORT ?? 0), { host: "127.0.0.1" });
process.parentPort.postMessage({ type: "ready", port: running.port });

process.parentPort.on("message", (e: { data: { type: string; dir?: string | null; url?: string | null; env?: Record<string, string> } }) => {
  if (e.data.type === "project") useProject(e.data.dir ?? null);
  if (e.data.type === "page") {
    setBrowserUrl(e.data.url ?? null);
    console.log(`[browser] page: ${e.data.url ?? "(none)"}`);
  }
  if (e.data.type === "env" && e.data.env) {
    applyEnv(e.data.env);
    // Agents copy the environment when they start, so a key change has to replace the warm ones.
    stopWarm();
    warmSaved();
    console.log("[settings] API keys updated");
  }
});

useProject(process.env.PROJECT_DIR || null);
void loadPriceCatalog();
// On-device speech: only the selected Voice / Speech models' engines (server/speechEngines.ts).
startSavedSpeech();
