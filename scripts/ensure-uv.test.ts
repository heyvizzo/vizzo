import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ensure-uv-"));
  roots.push(root);
  const executable = (name: string, script: string) => writeFileSync(join(root, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  // No network or real installation: record the installer request and put a fake uv on the isolated PATH.
  executable("curl", 'printf "%s\\n" "$@" > "$TEST_UV_DIR/download"; printf "fake installer"');
  executable("env", 'printf "%s\\n" "$@" > "$TEST_UV_DIR/options"; /bin/cat >/dev/null; /bin/cp "$TEST_UV_DIR/curl" "$TEST_UV_DIR/uv"');
  return {
    root, executable,
    run: (consent: boolean) => spawnSync("/bin/bash", ["-c", 'set -euo pipefail; source "$1"; ensure_uv; echo "Model setup continues"', "test", join(import.meta.dirname, "ensure-uv.sh")], {
      encoding: "utf8", env: { ...process.env, PATH: root, TEST_UV_DIR: root, VIZZO_INSTALL_UV: consent ? "1" : "0" },
    }),
  };
}

it("doesn't download uv without consent", () => {
  const f = fixture();
  const result = f.run(false);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("uv is required");
  expect(existsSync(join(f.root, "download"))).toBe(false);
  expect(result.stdout).not.toContain("Model setup continues");
});

it("installs missing uv after consent and continues model setup", () => {
  const f = fixture();
  const result = f.run(true);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Installing uv");
  expect(result.stdout).toContain("Model setup continues");
  expect(existsSync(join(f.root, "uv"))).toBe(true);
});

it("uses existing uv without invoking the installer", () => {
  const f = fixture();
  f.executable("uv", "exit 0");
  expect(f.run(false).status).toBe(0);
  expect(existsSync(join(f.root, "download"))).toBe(false);
});

it("stops model setup when downloading uv fails", () => {
  const f = fixture();
  f.executable("curl", "exit 22");
  const result = f.run(true);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Could not install uv");
  expect(result.stdout).not.toContain("Model setup continues");
});
