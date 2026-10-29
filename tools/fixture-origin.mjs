#!/usr/bin/env node
// Hermetic fixture origin: serves the vendored corpus with the CORS and Range headers a browser
// needs, plus a loader page. It listens on loopback only and fetches nothing. Playwright starts it
// through `webServer` and stops it when the run ends, including on failure.
import { createServer } from "node:http";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const TYPES = { ".json": "application/json", ".js": "text/javascript", ".html": "text/html" };
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
};

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start;
  let end;
  if (m[1] === "") {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start > end || start >= size ? "bad" : { start, end };
}

export function createOrigin({ corpusDir, appDir }) {
  const corpusRoot = resolve(corpusDir);
  const appRoot = appDir ? resolve(appDir) : null;
  return createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          ...CORS,
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "Range, If-None-Match, If-Match, If-Range",
          "Access-Control-Max-Age": "600",
        });
        return res.end();
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      let path = decodeURIComponent(url.pathname);
      let corrupt = false;
      if (path.startsWith("/corrupt/")) {
        corrupt = true;
        path = path.slice("/corrupt".length);
      }
      let root;
      let rel;
      if (path.startsWith("/corpus/")) {
        root = corpusRoot;
        rel = path.slice("/corpus/".length);
      } else if (appRoot && path.startsWith("/app/")) {
        root = appRoot;
        rel = path.slice("/app/".length);
      } else {
        res.writeHead(404, CORS);
        return res.end("not found");
      }
      const file = resolve(root, rel);
      if (!file.startsWith(root + sep) || !(await stat(file).then((s) => s.isFile(), () => false))) {
        res.writeHead(404, CORS);
        return res.end("not found");
      }
      let body = await readFile(file);
      if (corrupt) {
        body = Buffer.from(body);
        body[body.length - 2] ^= 0x01;
      }
      const headers = {
        ...CORS,
        "Accept-Ranges": "bytes",
        "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      };
      const range = req.headers.range ? parseRange(req.headers.range, body.length) : null;
      if (range === "bad" || (req.headers.range && range === null)) {
        res.writeHead(416, { ...headers, "Content-Range": `bytes */${body.length}` });
        return res.end();
      }
      if (range) {
        const part = body.subarray(range.start, range.end + 1);
        res.writeHead(206, { ...headers, "Content-Range": `bytes ${range.start}-${range.end}/${body.length}`, "Content-Length": part.length });
        return res.end(req.method === "HEAD" ? undefined : part);
      }
      res.writeHead(200, { ...headers, "Content-Length": body.length });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(500, CORS);
      res.end("error");
    }
  });
}

async function main() {
  const root = join(here, "..");
  const appDir = join(root, ".cache", "app");
  await mkdir(appDir, { recursive: true });
  const { build } = await import("esbuild");
  await build({
    entryPoints: [join(root, "tests", "fixtures", "browser-entry.ts")],
    bundle: true,
    format: "esm",
    outfile: join(appDir, "loader.js"),
    logLevel: "error",
  });
  await copyFile(join(root, "tests", "fixtures", "pin.json"), join(appDir, "pin.json"));
  await writeFile(join(appDir, "index.html"), '<!doctype html><meta charset="utf-8"><title>origin</title><script type="module" src="loader.js"></script>');
  const port = Number(process.env.PORT ?? 4173);
  createOrigin({ corpusDir: join(root, "tests", "fixtures", "corpus"), appDir }).listen(port, "127.0.0.1", () =>
    console.log(`fixture origin on http://127.0.0.1:${port}`),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
