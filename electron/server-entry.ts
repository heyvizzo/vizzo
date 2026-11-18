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
import { threadsFile } from "../server/threads/persist.ts";
import { flushThreadLifecycle, monitorThreadCompletion, restoreThreadLifecycle } from "../server/threads/lifecycle.ts";
import { onActivity, runningTasks } from "../server/activity.ts";
import { changesService } from "../server/changes/changesService.ts";
import { changesStatus, subscribeChangesStatus } from "../server/changes/http.ts";
import type { ChangesStatus } from "../shared/changes.ts";

function useProject(dir: string | null) {
  setProjectDir(dir);
  void changesService().scanner.setProject(projectDir());
  // The solver's agents start in the project folder: re-warm (the old ones are killed).
  warmSaved();
  console.log(`[server] project folder: ${projectDir() ?? "(none)"}`);
}

// The thread list comes back from the last run, and every change is saved (server/threads/persist.ts).
await restoreThreadLifecycle(threadsFile()).catch((error) => console.warn("[threads] could not recover saved threads", error));
monitorThreadCompletion();
const running = await startServer(Number(process.env.PORT ?? 0), { host: "127.0.0.1" });
process.parentPort.postMessage({ type: "ready", port: running.port });
let changesRequest = 0;
function publishChangesStatus(status: ChangesStatus) {
  process.parentPort.postMessage({ type: "changes-status", status, changesRequest });
}
subscribeChangesStatus(changesService(), publishChangesStatus);
// What's working, for the quit prompt and finishing in the background (electron/main.ts, "quitting").
onActivity((c) => process.parentPort.postMessage({ type: "activity", ...c }));
process.parentPort.postMessage({ type: "activity", running: runningTasks() });

let instructionsTimer: ReturnType<typeof setTimeout> | undefined;
process.parentPort.on("message", (e: { data: {
  type: string;
  dir?: string | null;
  url?: string | null;
  env?: Record<string, string>;
  visible?: boolean;
  changesRequest?: number;
} }) => {
  // The app is about to stop this process: what changed in the last moments goes to disk first.
  if (e.data.type === "flush") {
    void flushThreadLifecycle().catch((error) => console.warn("[changes] could not flush source-control state", error))
      .finally(() => process.parentPort.postMessage({ type: "flushed" }));
  }
  if (e.data.type === "instructions") {
    // Saving text is immediate; wait for a typing pause before replacing idle warm agents.
    // Dispatch reads the saved text directly, and active threads refresh only before their next request.
    clearTimeout(instructionsTimer);
    instructionsTimer = setTimeout(() => warmSaved(), 500);
  }
  if (e.data.type === "project") {
    changesRequest = e.data.changesRequest ?? 0;
    useProject(e.data.dir ?? null);
    publishChangesStatus(changesStatus());
  }
  if (e.data.type === "changes-visible") void changesService().scanner.setVisible(e.data.visible === true);
  if (e.data.type === "changes-focus") void changesService().scanner.focus();
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
publishChangesStatus(changesStatus());
void loadPriceCatalog();
// On-device speech: only the selected Voice / Speech models' engines (server/speechEngines.ts).
startSavedSpeech();
