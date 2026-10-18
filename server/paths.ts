// Where the server's files live. In the repo, import.meta.url points at server/. When bundled into the Electron
// app it points at dist-electron/, so the Electron entry sets APP_ROOT (the repo or app root, with a trailing slash).
import { fileURLToPath } from "node:url";

export const APP_ROOT = process.env.APP_ROOT ?? fileURLToPath(new URL("../", import.meta.url));
export const SERVER_DIR = `${APP_ROOT}server/`;
/**
 * Where the on-device speech engines' downloads live: .models/, .venv-tts and .venv-stt (server/speechInstall.ts).
 * The repo root for `npm run dev`; the packaged app sets SPEECH_DATA_DIR to a folder in Application Support, since
 * the app bundle is read-only and replaced by every update.
 */
export const SPEECH_ROOT = process.env.SPEECH_DATA_DIR ? process.env.SPEECH_DATA_DIR.replace(/\/*$/, "/") : APP_ROOT;
