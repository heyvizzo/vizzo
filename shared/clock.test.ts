import { describe, expect, it } from "vitest";
import { bestOffset, serverToClient } from "./clock.ts";

describe("bestOffset", () => {
  it("picks the lowest-RTT sample", () => {
    const r = bestOffset([
      { clientSent: 0, clientRecv: 20, serverNow: 1015 },
      { clientSent: 100, clientRecv: 104, serverNow: 1102 },
    ]);
    expect(r).toEqual({ rttMs: 4, offsetMs: 1000 });
    expect(serverToClient(1102, r!.offsetMs)).toBe(102);
  });
  it("returns null for no samples", () => expect(bestOffset([])).toBeNull());
});
