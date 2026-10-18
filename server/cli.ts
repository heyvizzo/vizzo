// `npm run dev:server` / `tsx server/cli.ts`: listen on PORT (default 8787). Kept out of index.ts so the server
// module has no side effects and can be bundled into the Electron app.
import { pathToFileURL } from "node:url";
import { startServer, type StartServerOpts } from "./index.ts";
import { setProjectDir } from "./project.ts";
import { loadDesktopEnv } from "../electron/settings.ts";

// FAKE_VENDORS=1: every vendor is faked (tones, canned text) so the UI can be tried without keys. Runs aren't saved.
async function fakeVendorOpts(): Promise<StartServerOpts> {
  const { createFakeDeps, REALISTIC_TIMING } = await import("./orchestrators/fakes.ts");
  const { createPipelineOrchestrator } = await import("./orchestrators/pipeline.ts");
  const { createCursorOnlyOrchestrator } = await import("./orchestrators/cursorOnly.ts");
  const deps = () => createFakeDeps(REALISTIC_TIMING);
  console.log("[server] FAKE_VENDORS=1: using fake adapters, runs are not persisted");
  return {
    persist: false,
    orchestrators: {
      pipeline: createPipelineOrchestrator(deps()),
      "cursor-only": createCursorOnlyOrchestrator(deps().openScribe),
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // Shell variables win. Missing keys come from the desktop settings file (the keys saved in Settings).
  loadDesktopEnv();
  const port = Number(process.env.PORT ?? 8787);
  // PROJECT_DIR=/path/to/project: the folder the demo page and the solver read (checked before anything starts).
  try { setProjectDir(process.env.PROJECT_DIR); } catch (e) { console.error(`[server] ${(e as Error).message}`); process.exit(1); }
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
  // Warm agents for the last tier selection (router, progress lines, solver) once the server is up.
  // WARM_AGENTS=0 skips them.
  await import("./adapters/claude.ts"); // registers the roles' prompts
  const { warmSaved } = await import("./llmSelection.ts");
  warmSaved();
  // Prices for models outside Claude's table (Codex, Grok, Pi / OhMyPi…), fetched in the background.
  if (process.env.FAKE_VENDORS !== "1") {
    const { loadPriceCatalog } = await import("./prices.ts");
    void loadPriceCatalog();
  }
  // On-device speech: only the selected Voice / Speech models' engines, started now so the model is loaded before
  // the first turn (server/speechEngines.ts; LOCAL_TTS=0 / LOCAL_STT=0 skip them).
  const { startSavedSpeech } = await import("./speechEngines.ts");
  startSavedSpeech();
}
