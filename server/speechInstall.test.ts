import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInstaller, dirBytes, downloadProgress, toolPath, type EngineSpec } from "./speechInstall.ts";

const SPECS: EngineSpec[] = [
  { kind: "tts", engine: "macos", builtin: true },
  { kind: "tts", engine: "kokoro", venv: ".venv-tts", dir: "kokoro", needs: ["kokoro/model.onnx"], modelBytes: 1000 },
  { kind: "tts", engine: "piper", venv: ".venv-tts", dir: "piper", needs: ["piper/voice.onnx"], modelBytes: 1000, voices: [{ id: "ryan", bytes: 1000 }, { id: "amy", bytes: 1000 }] },
  { kind: "stt", engine: "whisperkit", dir: "whisperkit", needs: ["whisperkit/model"], modelBytes: 1000, tool: "whisperkit-cli", finishing: "Compiling" },
];

/** A fake setup script per engine: bash run in the data folder, like scripts/setup-local-*.sh. */
const INSTALL: Record<string, string> = {
  kokoro: `mkdir -p .venv-tts/bin && touch .venv-tts/bin/python && echo "Downloading model.onnx" && head -c 400 /dev/zero > .models/kokoro/model.onnx`,
  piper: `mkdir -p .venv-tts/bin && touch .venv-tts/bin/python && echo "Downloading voice.onnx" && head -c 10 /dev/zero > .models/piper/voice.onnx`,
  whisperkit: `mkdir -p .models/whisperkit/model`,
  // One more Piper voice: the .json, then the .onnx through a .part file, like the real script's fetch.
  "piper/ryan": `echo "Downloading ryan.onnx"; touch .models/piper/ryan.onnx.json; head -c 600 /dev/zero > .models/piper/ryan.onnx.part; sleep 0.3; mv .models/piper/ryan.onnx.part .models/piper/ryan.onnx`,
  "piper/amy": `echo "404" >&2; exit 22`,
};

let roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

function setup(script: Record<string, string> = INSTALL, extra: { hasTool?: boolean; netBytes?: () => number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "speech-install-")) + "/";
  roots.push(root);
  const stop = vi.fn();
  const onInstalled = vi.fn();
  const installer = createInstaller({
    root,
    specs: SPECS,
    run: (_spec, cwd, args) => spawn("bash", ["-c", script[args[0]!] ?? "exit 0"], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] }),
    hasTool: () => extra.hasTool ?? true,
    stop,
    onInstalled,
    progressMs: 20,
    // The network counter (nettop in the app): what a download into a temp folder shows before its file appears.
    meter: () => ({ received: extra.netBytes ?? (() => 0), stop: () => {} }),
  });
  const state = (engine: string) => installer.states().find((s) => s.engine === engine)!;
  return { root, installer, state, stop, onInstalled };
}

describe("speech installer", () => {
  it("lists built-in engines as installed and the rest with their download size (models + the Python env)", () => {
    const { state } = setup();
    expect(state("macos")).toMatchObject({ builtin: true, installed: true, state: "idle" });
    expect(state("kokoro")).toMatchObject({ installed: false, state: "idle" });
    expect(state("kokoro").downloadBytes).toBeGreaterThan(1000); // the env isn't there yet
    expect(state("whisperkit").downloadBytes).toBe(1000); // no env
  });

  it("installs an engine: runs its script, then it's installed with its size on disk", async () => {
    const { root, installer, state, onInstalled } = setup();
    expect(installer.install("tts", "kokoro")).toMatchObject({ state: "queued", installed: false });
    await installer.idle();
    expect(state("kokoro")).toMatchObject({ installed: true, state: "idle", diskBytes: 400 });
    expect(existsSync(`${root}.models/kokoro/.installing`)).toBe(false);
    expect(onInstalled).toHaveBeenCalledWith("tts", "kokoro");
  });

  it("a failed install shows the script's last lines and doesn't count as installed", async () => {
    const { root, installer, state, onInstalled } = setup({ kokoro: `echo "Setting up Python"; echo "uv is required" >&2; exit 1` });
    installer.install("tts", "kokoro");
    await installer.idle();
    expect(state("kokoro")).toMatchObject({ installed: false, state: "error" });
    expect(state("kokoro").error).toContain("uv is required");
    expect(existsSync(`${root}.models/kokoro/.installing`)).toBe(true);
    expect(onInstalled).not.toHaveBeenCalled();
  });

  it("a script that exits 0 without the files is a failure", async () => {
    const { installer, state } = setup({ kokoro: "true" });
    installer.install("tts", "kokoro");
    await installer.idle();
    expect(state("kokoro").state).toBe("error");
  });

  it("an unfinished install (the .installing marker) isn't installed even when the files are there", () => {
    const { root, state } = setup();
    mkdirSync(`${root}.venv-tts/bin`, { recursive: true });
    writeFileSync(`${root}.venv-tts/bin/python`, "");
    mkdirSync(`${root}.models/kokoro`, { recursive: true });
    writeFileSync(`${root}.models/kokoro/model.onnx`, "x");
    expect(state("kokoro").installed).toBe(true);
    writeFileSync(`${root}.models/kokoro/.installing`, "");
    expect(state("kokoro").installed).toBe(false);
  });

  it("needs its tool too (WhisperKit's whisperkit-cli)", async () => {
    const { installer, state } = setup(INSTALL, { hasTool: false });
    installer.install("stt", "whisperkit");
    await installer.idle();
    expect(state("whisperkit")).toMatchObject({ installed: false, state: "error" });
  });

  it("runs one install at a time: the next waits, queued", async () => {
    const { installer, state } = setup({ ...INSTALL, kokoro: `sleep 0.3; ${INSTALL.kokoro}` });
    installer.install("tts", "kokoro");
    installer.install("tts", "piper");
    await vi.waitFor(() => expect(state("kokoro").state).toBe("installing"));
    expect(state("piper").state).toBe("queued");
    await installer.idle();
    expect(state("kokoro").installed && state("piper").installed).toBe(true);
  });

  it("reports the step and the progress while installing", async () => {
    const { installer, state } = setup({ kokoro: `mkdir -p .models/kokoro; echo "Downloading model.onnx"; head -c 500 /dev/zero > .models/kokoro/part; sleep 0.5` });
    installer.install("tts", "kokoro");
    await vi.waitFor(() => expect(state("kokoro").progress).toBeGreaterThanOrEqual(0.5));
    expect(state("kokoro").phase).toBe("Downloading model.onnx");
    installer.cancel("tts", "kokoro");
  });

  it("counts what the network brings in when the files don't show it yet (downloads into a temp folder)", async () => {
    let net = 0;
    const { installer, state } = setup({ ...INSTALL, whisperkit: `echo "Setting up"; sleep 0.15; echo "Downloading model"; sleep 0.4` }, { netBytes: () => net });
    installer.install("stt", "whisperkit");
    await vi.waitFor(() => expect(state("whisperkit").phase).toBe("Setting up"));
    net = 300; // Python packages: not the model's
    await new Promise((r) => setTimeout(r, 60));
    expect(state("whisperkit").progress).toBeUndefined(); // a busy bar
    await vi.waitFor(() => expect(state("whisperkit").phase).toBe("Downloading model"));
    await new Promise((r) => setTimeout(r, 60));
    net = 300 + 600;
    await vi.waitFor(() => expect(state("whisperkit")).toMatchObject({ progress: 0.6, receivedBytes: 600, totalBytes: 1000 }));
    net = 300 + 1000; // all in; the script is still at work: what it's doing instead of a stuck 99%
    await vi.waitFor(() => expect(state("whisperkit")).toMatchObject({ phase: "Compiling" }));
    expect(state("whisperkit").progress).toBeUndefined();
    installer.cancel("stt", "whisperkit");
  });

  it("Cancel kills the script (and what it started) and leaves it not installed", async () => {
    const { root, installer, state } = setup({ kokoro: `sleep 30 & wait` });
    installer.install("tts", "kokoro");
    await vi.waitFor(() => expect(state("kokoro").state).toBe("installing"));
    installer.cancel("tts", "kokoro");
    expect(state("kokoro")).toMatchObject({ installed: false, state: "idle" });
    await installer.idle(); // resolves: the script was killed
    expect(state("kokoro").state).toBe("idle");
    expect(existsSync(`${root}.models/kokoro/.installing`)).toBe(true); // Install again resumes
  });

  it("Cancel of a queued install keeps it from running", async () => {
    const { installer, state } = setup({ ...INSTALL, kokoro: `sleep 0.2; ${INSTALL.kokoro}` });
    installer.install("tts", "kokoro");
    installer.install("tts", "piper");
    installer.cancel("tts", "piper");
    await installer.idle();
    expect(state("piper")).toMatchObject({ installed: false, state: "idle" });
  });

  it("uninstalls: stops the engine, deletes its models, and the env once no engine of its kind is left", async () => {
    const { root, installer, state, stop } = setup();
    installer.install("tts", "kokoro");
    installer.install("tts", "piper");
    await installer.idle();
    installer.uninstall("tts", "kokoro");
    expect(stop).toHaveBeenCalledWith("tts", "kokoro");
    expect(existsSync(`${root}.models/kokoro`)).toBe(false);
    expect(existsSync(`${root}.venv-tts`)).toBe(true); // Piper still uses it
    expect(state("kokoro").installed).toBe(false);
    installer.uninstall("tts", "piper");
    expect(existsSync(`${root}.venv-tts`)).toBe(false);
  });

  it("won't uninstall a built-in engine or one that's installing", async () => {
    const { installer } = setup({ kokoro: "sleep 30 & wait" });
    expect(() => installer.uninstall("tts", "macos")).toThrow(/built into macOS/);
    installer.install("tts", "kokoro");
    expect(() => installer.uninstall("tts", "kokoro")).toThrow(/cancel/);
    installer.cancel("tts", "kokoro");
    await installer.idle();
  });

  it("downloads one more voice of an installed engine, with its progress, without touching the engine", async () => {
    const { root, installer, state, onInstalled } = setup();
    expect(() => installer.installVoice("tts", "piper", "ryan")).toThrow(/install piper first/);
    installer.install("tts", "piper");
    await installer.idle();
    onInstalled.mockClear();
    installer.installVoice("tts", "piper", "ryan");
    expect(state("piper").voices).toEqual([{ voice: "ryan", state: "queued" }]);
    await vi.waitFor(() => expect(state("piper").voices?.[0]?.progress).toBeGreaterThan(0.5));
    expect(state("piper").installed).toBe(true); // Piper stays usable meanwhile
    await installer.idle();
    expect(state("piper").voices).toBeUndefined();
    expect(existsSync(`${root}.models/piper/ryan.onnx`)).toBe(true);
    expect(onInstalled).not.toHaveBeenCalled();
    installer.installVoice("tts", "piper", "ryan"); // already there: nothing to do
    expect(state("piper").voices).toBeUndefined();
  });

  it("a failed voice download shows its error; an unknown voice is refused", async () => {
    const { installer, state } = setup();
    installer.install("tts", "piper");
    await installer.idle();
    installer.installVoice("tts", "piper", "amy");
    await installer.idle();
    expect(state("piper").voices).toEqual([{ voice: "amy", state: "error", error: "404" }]);
    expect(() => installer.installVoice("tts", "piper", "../../etc")).toThrow(/no voice/);
  });

  it("a voice download can be cancelled, and blocks Uninstall while it runs", async () => {
    const { installer, state } = setup({ ...INSTALL, "piper/ryan": "sleep 30 & wait" });
    installer.install("tts", "piper");
    await installer.idle();
    installer.installVoice("tts", "piper", "ryan");
    await vi.waitFor(() => expect(state("piper").voices?.[0]?.state).toBe("installing"));
    expect(() => installer.uninstall("tts", "piper")).toThrow(/cancel/);
    installer.cancelVoice("tts", "piper", "ryan");
    await installer.idle();
    expect(state("piper").voices).toBeUndefined();
    installer.uninstall("tts", "piper");
    expect(state("piper").installed).toBe(false);
  });

  it("rejects unknown engines", () => {
    const { installer } = setup();
    expect(() => installer.install("tts", "nope")).toThrow(/unknown/);
  });
});

describe("toolPath", () => {
  it("adds Homebrew's and uv's folders a Finder-launched app lacks, once", () => {
    const p = toolPath("/usr/bin:/bin:/opt/homebrew/bin").split(":");
    expect(p.slice(0, 3)).toEqual(["/usr/bin", "/bin", "/opt/homebrew/bin"]);
    expect(p.filter((d) => d === "/opt/homebrew/bin")).toHaveLength(1);
    expect(p).toContain("/usr/local/bin");
    expect(p.some((d) => d.endsWith("/.local/bin"))).toBe(true);
  });
});

describe("dirBytes", () => {
  it("adds up the files under a folder (0 when it's missing)", () => {
    const root = mkdtempSync(join(tmpdir(), "dir-bytes-"));
    roots.push(root);
    mkdirSync(join(root, "a/b"), { recursive: true });
    writeFileSync(join(root, "a/x"), "12345");
    writeFileSync(join(root, "a/b/y"), "123");
    expect(dirBytes(root)).toBe(8);
    expect(dirBytes(join(root, "missing"))).toBe(0);
  });
});

describe("downloadProgress", () => {
  it("measures only while downloading, from the larger of files and network, and hands over near the end", () => {
    expect(downloadProgress("Setting up Python", 0, 500, 1000)).toBeUndefined();
    expect(downloadProgress("Downloading x", 200, 500, 1000)).toBe(0.5);
    expect(downloadProgress("Downloading x", 700, 500, 1000)).toBe(0.7);
    expect(downloadProgress("Downloading x", 0, 990, 1000)).toBeUndefined();
    expect(downloadProgress("Downloading x", 10, 0, 0)).toBeUndefined();
  });
});
