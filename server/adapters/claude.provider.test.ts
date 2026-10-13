import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpusParams, claudeProvider, hasClaudeCredentials, modelId } from "./claude.ts";

afterEach(() => vi.unstubAllEnvs());

describe("Claude provider selection", () => {
  it("uses OpenRouter when OPENROUTER_API_KEY is set", () => {
    vi.stubEnv("CLAUDE_PROVIDER", "");
    vi.stubEnv("OPENROUTER_API_KEY", "or-test");
    expect(claudeProvider()).toBe("openrouter");
    expect(hasClaudeCredentials()).toBe(true);
    expect(modelId("claude-opus-5-5")).toBe("anthropic/claude-opus-5.5");
    expect(modelId("claude-haiku-5-5")).toBe("anthropic/claude-haiku-5.5");
  });

  it("CLAUDE_PROVIDER=anthropic overrides and keeps Anthropic model IDs", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "or-test");
    vi.stubEnv("CLAUDE_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(modelId("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(hasClaudeCredentials()).toBe(false);
  });

  it("OpenRouter Opus params drop the refusal fallback (OpenRouter 400s on it)", () => {
    vi.stubEnv("CLAUDE_PROVIDER", "openrouter");
    const p = buildOpusParams("q", [], false) as unknown as Record<string, unknown>;
    expect(p.model).toBe("anthropic/claude-opus-5.5");
    expect(p.fallbacks).toBeUndefined();
    expect(p.betas).toBeUndefined();
    const fast = buildOpusParams("q", [], true) as unknown as Record<string, unknown>;
    expect(fast.betas).toEqual(["fast-mode-2026-02-01"]);
    expect(fast.speed).toBe("fast");
  });

  it("Anthropic-direct Opus params keep the refusal fallback", () => {
    vi.stubEnv("CLAUDE_PROVIDER", "anthropic");
    const p = buildOpusParams("q", [], false) as unknown as Record<string, unknown>;
    expect(p.fallbacks).toBe("default");
  });
});
