// One hermetic static server for the examples: fixtures (in memory, Range aware), the packed
// package, and the example pages. Binds 127.0.0.1 only, never reaches out, and always closes.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { createHash } from "node:crypto";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".wasm": "application/wasm", ".css": "text/css; charset=utf-8", ".json": "application/json" };

/**
 * routes: { "/pkg": "<dir>", "/": "<dir>" } map URL prefixes to directories; fixtures: { "/fixtures/a.pvec": Uint8Array }.
 * csp is sent on every response when given. Returns { url, close, log }.
 */
export async function startServer({ routes = {}, fixtures = {}, csp, headers = {} } = {}) {
  const log = [];
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    log.push({ path: u.pathname, range: req.headers.range ?? null });
    const send = (status, body, type = "application/octet-stream") => {
      const h = { "content-type": type, "cache-control": "no-store", ...headers };
      if (body) h.etag = `"${createHash("sha1").update(body).digest("hex")}"`;
      if (csp) h["content-security-policy"] = csp;
      if (body && req.headers.range && status === 200) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        if (m) {
          const a = Number(m[1]);
          const b = Math.min(m[2] === "" ? body.length - 1 : Number(m[2]), body.length - 1);
          h["content-range"] = `bytes ${a}-${b}/${body.length}`;
          h["accept-ranges"] = "bytes";
          res.writeHead(206, h);
          return res.end(body.subarray(a, b + 1));
        }
      }
      res.writeHead(status, body ? { ...h, "content-length": body.length, "accept-ranges": "bytes" } : h);
      res.end(body);
    };
    try {
      if (fixtures[u.pathname]) return send(200, fixtures[u.pathname]);
      for (const [prefix, dir] of Object.entries(routes).sort((a, b) => b[0].length - a[0].length)) {
        const base = prefix.endsWith("/") ? prefix : prefix + "/";
        if (!(u.pathname + "/").startsWith(base) && u.pathname !== prefix) continue;
        const rel = normalize(decodeURIComponent(u.pathname.slice(prefix.length))).replace(/^([/\\])+/, "");
        const file = join(dir, rel);
        if (!file.startsWith(dir + sep) && file !== dir) return send(403);
        const target = (await stat(file)).isDirectory() ? join(file, "index.html") : file;
        return send(200, await readFile(target), TYPES[extname(target)]);
      }
      send(404);
    } catch {
      send(404);
    }
  });
  server.on("connection", (s) => (sockets.add(s), s.on("close", () => sockets.delete(s))));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const close = () =>
    new Promise((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    });
  return { url: `http://127.0.0.1:${port}`, port, close, log };
}

/** Runs fn with a server and closes it afterwards, including when fn throws. */
export async function withServer(options, fn) {
  const s = await startServer(options);
  const stop = () => void s.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    return await fn(s);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await s.close();
  }
}
