import { afterEach, expect, it, vi } from "vitest";
import { requestSpeechInstall } from "./speechInstall.ts";

afterEach(() => vi.unstubAllGlobals());
const request = { kind: "tts", engine: "kokoro", action: "install" };
const missing = { installs: [], missingDependency: "uv", error: "uv is required" };
const ready = { installs: [] };
function responses(...results: unknown[]) {
  const fetch = vi.fn();
  for (const result of results) fetch.mockResolvedValueOnce({ json: async () => result });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("confirms missing uv and retries the model install with explicit consent", async () => {
  const fetch = responses(missing, ready);
  const confirm = vi.fn(() => true);
  expect(await requestSpeechInstall(request, "Kokoro", confirm)).toEqual(ready);
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Kokoro needs uv"));
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual(request);
  expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({ ...request, installUv: true });
});

it("cancel leaves the model unqueued and doesn't authorize uv installation", async () => {
  const fetch = responses(missing);
  expect(await requestSpeechInstall(request, "Kokoro", () => false)).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("doesn't prompt when uv is available or when an unrelated error occurs", async () => {
  const error = { installs: [], error: "unknown engine" };
  responses(ready, error);
  const confirm = vi.fn();
  expect(await requestSpeechInstall(request, "Kokoro", confirm)).toEqual(ready);
  expect(await requestSpeechInstall(request, "Kokoro", confirm)).toEqual(error);
  expect(confirm).not.toHaveBeenCalled();
});

it("returns an installation failure after confirmation without prompting again", async () => {
  const error = { installs: [], error: "Could not install uv" };
  responses(missing, error);
  const confirm = vi.fn(() => true);
  expect(await requestSpeechInstall(request, "Kokoro", confirm)).toEqual(error);
  expect(confirm).toHaveBeenCalledTimes(1);
});
