import { describe, expect, it } from "vitest";
import { bundlePath, tildify, uninstallPaths, type UninstallEnv } from "./uninstall.ts";

const H = "/Users/me";
const base: UninstallEnv = {
  home: H,
  userData: `${H}/Library/Application Support/realtime-voice-latency-lab`,
  root: `${H}/Sites/realtime-voice`,
  speechRoot: `${H}/Sites/realtime-voice`,
  exe: `${H}/Sites/realtime-voice/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`,
  packaged: false,
  tmp: "/var/folders/x/T",
  exists: () => true,
};

describe("uninstallPaths", () => {
  it("from the repo: the models, envs and settings, never the repo, Electron's bundle or its shared prefs", () => {
    expect(uninstallPaths(base)).toEqual([
      `${H}/Sites/realtime-voice/.models`,
      `${H}/Sites/realtime-voice/.venv-tts`,
      `${H}/Sites/realtime-voice/.venv-stt`,
      `${H}/Library/Application Support/realtime-voice-latency-lab`,
      `${H}/.config/realtime-voice`,
      "/var/folders/x/T/realtime-voice-agents",
    ]);
  });

  it("packaged: the .app bundle (covering what's inside it) and the Library files named after its bundle id", () => {
    const app = "/Applications/Voice Latency Lab.app";
    const paths = uninstallPaths({
      ...base, packaged: true, exe: `${app}/Contents/MacOS/Voice Latency Lab`,
      root: `${app}/Contents/Resources/app`, speechRoot: `${base.userData}/speech`, bundleId: "lab.voice",
    });
    expect(paths[0]).toBe(app);
    expect(paths.some((p) => p.startsWith(`${app}/`))).toBe(false);
    expect(paths).toContain(`${H}/Library/Preferences/lab.voice.plist`);
    expect(paths).toContain(`${H}/Library/Caches/lab.voice`);
    // The models live in userData when packaged: deleting userData covers them.
    expect(paths.some((p) => p.includes("/speech/"))).toBe(false);
    // Its selections are in userData too: what `npm run dev` keeps elsewhere stays.
    expect(paths).not.toContain(`${H}/.config/realtime-voice`);
    expect(paths).not.toContain("/var/folders/x/T/realtime-voice-agents");
  });

  it("lists only what exists, and never home, /, or the root itself", () => {
    const only = new Set([`${H}/.config/realtime-voice`]);
    expect(uninstallPaths({ ...base, exists: (p) => only.has(p) })).toEqual([`${H}/.config/realtime-voice`]);
    expect(uninstallPaths({ ...base, userData: `${H}/`, tmp: "/" })).not.toContain(H);
  });
});

it("bundlePath and tildify", () => {
  expect(bundlePath("/Applications/A B.app/Contents/MacOS/A B")).toBe("/Applications/A B.app");
  expect(bundlePath("/usr/local/bin/node")).toBeNull();
  expect(tildify(`${H}/.config/x`, H)).toBe("~/.config/x");
  expect(tildify("/tmp/x", H)).toBe("/tmp/x");
});
