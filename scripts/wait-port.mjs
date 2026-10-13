// Wait until something accepts TCP connections on localhost:<port> (used by `npm run dev` so Vite
// starts only once the server is listening, and the browser's /ws proxy never hits a closed port).
import { connect } from "node:net";
const port = Number(process.argv[2] ?? 8787);
const deadline = Date.now() + 60_000;
const tryOnce = () => {
  const s = connect(port, "localhost");
  s.once("connect", () => { s.destroy(); process.exit(0); });
  s.once("error", () => {
    s.destroy();
    if (Date.now() > deadline) { console.error(`[wait-port] nothing listening on ${port} after 60 s`); process.exit(1); }
    setTimeout(tryOnce, 150);
  });
};
tryOnce();
