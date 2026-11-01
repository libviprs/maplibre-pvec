// M1.2 on the real container: the production PVecSource and bootstrap() against real .pvec files from
// pvec's writer, served by an in-process Node range origin on loopback (no network). Run in a
// throw-away node container, tools/spike-real.sh drives it.
//   node spikes/pvec-real/range.mjs [out.json]
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");
const outFile = process.argv[2] ?? path.join(here, "range-results.json");
const lib = path.join(root, ".cache", "pvec-real-range.mjs");
await build({ entryPoints: [path.join(here, "range-entry.ts")], bundle: true, format: "esm", platform: "node", outfile: lib, logLevel: "error" });
const { PVecSource, bootstrap, BOOTSTRAP_MAX_REQUESTS, PREFIX_BYTES, loadEvaluator, bindPacked } = await import(lib);
// The evaluator reads the spatial directory (ABI 2). What a window needs from the file is the prefix, the directory
// section and the stored bytes of the hot blocks of the leaves the window touches.
const evaluator = await loadEvaluator({ wasmModule: await WebAssembly.compile(fs.readFileSync(path.join(root, "wasm/pvec_eval.wasm"))) });
const rt = bindPacked(evaluator);

const dirs = [path.join(root, "tests/fixtures/pvec"), path.join(root, ".cache/pvec-large")];
const files = dirs.flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".pvec")).map((f) => path.join(d, f)) : []));
// The "-tier0" files carry the spatial directory; the run of an entry is named after the entry, and the plain layout is kept as "<name>-plain".
const byName = new Map(files.map((f) => {
  const n = path.basename(f, ".pvec");
  const large = f.includes("pvec-large");
  return [n.endsWith("-tier0") ? n.slice(0, -6) : large ? `${n}-plain` : n, f];
}));

function origin(rttMs) {
  const log = [];
  const srv = http.createServer((req, res) => {
    const file = byName.get(decodeURIComponent(req.url.slice(1)));
    if (!file) { res.writeHead(404).end(); return; }
    const size = fs.statSync(file).size;
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    const start = m ? Number(m[1]) : 0;
    const end = m ? Math.min(m[2] === "" ? size - 1 : Number(m[2]), size - 1) : size - 1;
    log.push({ start, end });
    setTimeout(() => {
      const body = Buffer.alloc(end - start + 1);
      const fd = fs.openSync(file, "r"); fs.readSync(fd, body, 0, body.length, start); fs.closeSync(fd);
      res.writeHead(m ? 206 : 200, {
        "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes", ETag: '"v1"', "Content-Length": body.length,
        ...(m ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
      });
      res.end(body);
    }, rttMs);
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, log, port: srv.address().port })));
}

const presets = { fullExtent: 1, quarter: 0.25, small: 0.05 };
const results = {
  platform: `${os.arch()} ${os.type()} container, node ${process.version}`,
  note: "production PVecSource.bootstrap and queryBounds over real files from pvec's writer; Tier 0 here means the geometry blocks the directory lists for the viewport",
  bootstrapMaxRequests: BOOTSTRAP_MAX_REQUESTS,
  runs: [],
};
for (const rtt of [0, 100]) {
  for (const [name, file] of byName) {
    const { srv, log, port } = await origin(rtt);
    try {
      const size = fs.statSync(file).size;
      const src = new PVecSource({ url: `http://127.0.0.1:${port}/${name}`, workerCount: 1 }, { hardwareConcurrency: 2 });
      const t0 = performance.now();
      let h;
      try { h = await src.bootstrap(); } catch (e) { results.runs.push({ name, fileBytes: size, rttMs: rtt, error: `${e.code ?? ""} ${e.message}` }); continue; }
      const bootMs = performance.now() - t0;
      const run = {
        name, fileBytes: size, rttMs: rtt,
        bootstrap: { requests: h.requestCount, bytes: h.byteCount, ms: +bootMs.toFixed(1), blocks: h.directory.entries.length, spatialDirectory: !!h.spatialDirectory, producer: h.manifest.producer },
        viewports: [],
      };
      const b = h.manifest.sourceBounds, w = b.maxX - b.minX, ht = b.maxY - b.minY;
      const bytes = fs.readFileSync(file);
      const handle = rt.open(new Uint8Array(bytes));
      const hasDirectory = handle >= 0 && rt.directoryStat(handle, 0) === 1;
      run.spatialDirectory = hasDirectory;
      for (const [pname, f] of Object.entries(presets)) {
        const cx = b.minX + w * 0.5, cy = b.minY + ht * 0.5;
        const chunks = src.queryBounds({ minX: cx - (w * f) / 2, minY: cy - (ht * f) / 2, maxX: cx + (w * f) / 2, maxY: cy + (ht * f) / 2 }).slice().sort((x, y) => x.offset - y.offset);
        const ranges = [];
        for (const c of chunks) { const last = ranges.at(-1); if (last && last[1] === c.offset) last[1] = c.offset + c.length; else ranges.push([c.offset, c.offset + c.length]); }
        const before = log.length;
        const t1 = performance.now();
        await Promise.all(ranges.map(([s, e]) => src.readRange(s, e - s)));
        const ms = performance.now() - t1;
        let spatial = null;
        if (hasDirectory) {
          const q = rt.directoryQuery(handle, cx - (w * f) / 2, cy - (ht * f) / 2, cx + (w * f) / 2, cy + (ht * f) / 2);
          if (typeof q !== "number") {
            // The prefix, the directory section and the hot blocks of the touched leaves, as the directory states them.
            const cellBytes = q.bytes.reduce((a, x) => a + x, 0);
            spatial = { cells: q.cells.length, bytes: Math.round(PREFIX_BYTES + (h.spatialDirectory?.length ?? 0) + cellBytes) };
            rt.release(q.handle);
          }
        }
        run.viewports.push({ preset: pname, ...(spatial ? { spatial } : {}), chunks: chunks.length, ranges: ranges.length, requests: log.length - before, bytes: ranges.reduce((a, [s, e]) => a + (e - s), 0), serialRoundTrips: ranges.length ? 1 : 0, ms: +ms.toFixed(1), msTotalFromColdStart: +(bootMs + ms).toFixed(1) });
      }
      if (handle >= 0) rt.release(handle);
      results.runs.push(run);
    } finally { srv.close(); }
  }
}
fs.writeFileSync(outFile, JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results.runs.filter((r) => r.rttMs === 0).map((r) => r.error ? `${r.name} ERROR ${r.error}` : [r.name, r.fileBytes, r.bootstrap.requests, r.bootstrap.bytes, r.bootstrap.blocks, r.viewports.map((v) => `${v.preset}:${v.requests}r/${v.bytes}B`).join(" ")].join(" ")), null, 1));
