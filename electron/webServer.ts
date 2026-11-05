// The packaged app's stand-in for Vite (electron/main.ts startWebApp): serves the built pages (dist/, `vite build`)
// and passes /api and the /ws WebSocket on to the voice server, as vite.config.ts's proxy does in development. The
// voice server starts at launch; until it's listening /api answers 502, like Vite's proxy.
import { createServer, request, type Server } from "node:http";
import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".wasm": "application/wasm",
  ".map": "application/json", ".ico": "image/x-icon", ".wav": "audio/wav",
};

/** The file under `root` a URL path names, or null for one outside it. "/" → index.html. */
export function staticPath(root: string, urlPath: string): string | null {
  let path: string;
  try { path = decodeURIComponent(urlPath.split("?")[0] ?? "/"); } catch { return null; }
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(root, path));
  return file === root || file.startsWith(root.endsWith(sep) ? root : root + sep) ? file : null;
}

/** Serve `root` on 127.0.0.1:`port` (0: a free one), proxying /api and /ws to 127.0.0.1:`backendPort`. */
export function startWebServer(root: string, backendPort: number, port = 0): Promise<{ server: Server; port: number }> {
  const http = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/api/") || url === "/api") {
      const upstream = request({ host: "127.0.0.1", port: backendPort, method: req.method, path: url, headers: req.headers }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
      return;
    }
    const file = staticPath(root, url);
    if (!file || (req.method !== "GET" && req.method !== "HEAD")) { res.writeHead(404); res.end(); return; }
    readFile(file).then(
      (body) => {
        res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
        res.end(req.method === "HEAD" ? undefined : body);
      },
      () => { res.writeHead(404); res.end(); },
    );
  });
  // /ws: hand the upgrade request and the socket to the voice server as they are.
  http.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] !== "/ws") { socket.destroy(); return; }
    const upstream = connect(backendPort, "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const close = () => { upstream.destroy(); socket.destroy(); };
    upstream.on("error", close);
    socket.on("error", close);
    upstream.on("close", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  });
  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", () => {
      const address = http.address();
      resolve({ server: http, port: typeof address === "object" && address ? address.port : port });
    });
  });
}
