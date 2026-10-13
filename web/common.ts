import { LabSocket } from "./ws.ts";

/** Connect and show status + clock sync in the nav's #clock element. */
export function connectWithStatus(): LabSocket {
  const sock = new LabSocket();
  const el = document.getElementById("clock");
  const render = (status: string) => {
    if (!el) return;
    const c = sock.clock;
    el.textContent = c ? `${status} · RTT ${c.rttMs.toFixed(1)} ms · offset ${c.offsetMs.toFixed(1)} ms` : status;
    el.dataset.status = status;
  };
  sock.onStatus = render;
  sock.onClock = () => render("connected");
  return sock;
}
