import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_FACTORIES, type WarmAgent } from "./harnesses.ts";
import { annotation } from "./drawing.fixture.ts";

const agents: WarmAgent[] = [];
const dirs: string[] = [];
afterEach(() => { for (const a of agents.splice(0)) a.kill(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.unstubAllEnvs(); });

function binary(vision: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "vizzo-image-rpc-"));
  dirs.push(dir);
  const path = join(dir, "agent.cjs");
  writeFileSync(path, `#!/usr/bin/env node
const readline = require('node:readline');
const send = v => process.stdout.write(JSON.stringify(v) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
 const req = JSON.parse(line);
 if (req.type === 'get_state') return send({ id: req.id, type: 'response', success: true, command: 'get_state', data: { model: { input: ${JSON.stringify(vision ? ['text','image'] : ['text'])} } } });
 if (req.type !== 'prompt') return;
 if (req.images?.[0]?.data !== 'aGVsbG8=' || req.images[0].mimeType !== 'image/png') return send({ id: req.id, type: 'response', success: false, error: 'Missing native image' });
 send({ type: 'message_end', message: { role: 'assistant', content: [{type: 'text', text: 'received image'}], model: 'vision', stopReason: 'stop', usage: {} } });
 send({ type: 'agent_end' });
});
`, { mode: 0o755 });
  return path;
}

describe("native drawing RPC transport", () => {
  it.each(["pi", "omp"] as const)("%s sends images after checking actual model capability", async harness => {
    vi.stubEnv(harness === "pi" ? "PI_BIN" : "OMP_BIN", binary(true));
    const agent = AGENT_FACTORIES[harness]({ harness, role: "solver", model: "test/vision", system: "test" });
    agents.push(agent);
    await expect(agent.request("change", undefined, 3000, [annotation])).resolves.toMatchObject({ model: "vision", stopReason: "end_turn" });
  });
  it("rejects a non-vision model before a prompt can silently omit the drawing", async () => {
    vi.stubEnv("PI_BIN", binary(false));
    const agent = AGENT_FACTORIES.pi({ harness: "pi", role: "solver", model: "test/text", system: "test" });
    agents.push(agent);
    await expect(agent.request("change", undefined, 3000, [annotation])).rejects.toThrow("does not support drawing images");
  });
});
