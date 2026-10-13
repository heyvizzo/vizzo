// Clock sync (ARCHITECTURE §5). Client performance.now() is the reference clock.

export interface PingSample { clientSent: number; clientRecv: number; serverNow: number }
export interface ClockSync { rttMs: number; offsetMs: number }

/** Keep the lowest-RTT sample: offset = serverNow − (clientSent + rtt/2). */
export function bestOffset(samples: PingSample[]): ClockSync | null {
  let best: ClockSync | null = null;
  for (const s of samples) {
    const rtt = s.clientRecv - s.clientSent;
    if (rtt < 0) continue;
    if (!best || rtt < best.rttMs) best = { rttMs: rtt, offsetMs: s.serverNow - (s.clientSent + rtt / 2) };
  }
  return best;
}

export const serverToClient = (serverNow: number, offsetMs: number): number => serverNow - offsetMs;
export const clientToServer = (clientNow: number, offsetMs: number): number => clientNow + offsetMs;
