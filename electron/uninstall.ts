// App menu → Uninstall: what it deletes. The app bundle (only when packaged: run from the repo with `npm run dev`,
// the repo is the app and stays), the on-device speech models and their Python envs, and everything the app keeps
// in the user's Library and ~/.config. Homebrew tools an install added (whisperkit-cli) are shared, so they stay.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

export interface UninstallEnv {
  home: string;
  /** app.getPath("userData"): settings.json, the browser pane's cookies and storage, caches. */
  userData: string;
  /** The repo or app root: never deleted itself. */
  root: string;
  /** The speech data folder (SPEECH_DATA_DIR): .models/ and the Python envs are here. The repo root in dev. */
  speechRoot: string;
  /** process.execPath, for the .app bundle around it. */
  exe: string;
  packaged: boolean;
  tmp: string;
  /** The bundle's CFBundleIdentifier (packaged only): its Library files are named after it. */
  bundleId?: string | null;
  /** Only the paths that exist are listed. */
  exists?: (path: string) => boolean;
}

/** The .app bundle `exe` runs from, or null if it isn't in one. */
export function bundlePath(exe: string): string | null {
  return /^(\/.+?\.app)\/Contents\/MacOS\//.exec(exe)?.[1] ?? null;
}

/** CFBundleIdentifier from the bundle's Info.plist (XML), or null. */
export function readBundleId(bundle: string): string | null {
  try {
    return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(join(bundle, "Contents", "Info.plist"), "utf8"))?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Everything Uninstall deletes, existing paths only, none inside another (deleting the parent covers it). */
export function uninstallPaths(env: UninstallEnv): string[] {
  const { home, root, speechRoot, exists = existsSync } = env;
  const lib = join(home, "Library");
  const paths: (string | null)[] = [
    env.packaged ? bundlePath(env.exe) : null,
    join(speechRoot, ".models"),
    join(speechRoot, ".venv-tts"),
    join(speechRoot, ".venv-stt"),
    env.userData,
    // Run from the repo's: the packaged app keeps its selections in userData (electron/main.ts), so these stay
    // with `npm run dev`, which may be installed next to it.
    env.packaged ? null : join(home, ".config", "realtime-voice"),
    env.packaged ? null : join(env.tmp, "realtime-voice-agents"),
  ];
  // Unpackaged, these are Electron's own (com.github.Electron), shared with any other app run with `electron .`.
  if (env.packaged && env.bundleId) {
    const id = env.bundleId;
    paths.push(
      join(lib, "Preferences", `${id}.plist`),
      join(lib, "Saved Application State", `${id}.savedState`),
      join(lib, "Caches", id),
      join(lib, "HTTPStorages", id),
      join(lib, "Logs", id),
    );
  }
  const keep = new Set([home, "/", root, join(home, "Library"), join(home, ".config")].map(trimSlash));
  const list = [...new Set(paths.filter((p): p is string => !!p).map(trimSlash))]
    .filter((p) => p.startsWith("/") && !keep.has(p) && exists(p));
  return list.filter((p) => !list.some((q) => q !== p && p.startsWith(q + sep)));
}

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/** `path` with the home folder as ~, for the confirm dialog. */
export function tildify(path: string, home = homedir()): string {
  return path === home || path.startsWith(home + sep) ? "~" + path.slice(home.length) : path;
}
