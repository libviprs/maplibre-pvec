// Throwaway spike (M1.2). Provisional synthetic container, hermetic in-process origin.
// The real layout is not frozen until P1.8, so this reports the request pattern as a function of
// directory fanout and block granularity. Pure Node, no third-party endpoint.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const HEADER = 64, MANIFEST = 4096, DIR_ENTRY = 40; // bbox 4xf64 + offset u32 + len u32
const T0_ENTITY = 48; // bytes of Tier 0 geometry per entity (provisional)

// Deterministic PRNG so every run builds the same container.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// Entities: dense cluster in a 0.1 x 0.1 corner square (60% of entities), rest uniform in unit square.
function buildFixture(n, perBlock, fanout) {
  const r = rng(7), ents = [];
  for (let i = 0; i < n; i++) {
    const dense = r() < 0.6;
    ents.push(dense ? [r() * 0.1, r() * 0.1] : [r(), r()]);
  }
  // Blocks by Morton-ish sort on a 256 grid, then chunked by perBlock entities.
  const key = ([x, y]) => { let k = 0, xi = Math.floor(x * 255.99), yi = Math.floor(y * 255.99); for (let b = 0; b < 8; b++) k |= ((xi >> b & 1) << (2 * b)) | ((yi >> b & 1) << (2 * b + 1)); return k; };
  ents.sort((a, b) => key(a) - key(b));
  const blocks = [];
  for (let i = 0; i < n; i += perBlock) {
    const part = ents.slice(i, i + perBlock);
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const [x, y] of part) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    blocks.push({ bbox: [x0, y0, x1, y1], len: part.length * T0_ENTITY, count: part.length });
  }
  // Directory tree with the given fanout: leaves are block entries, interior nodes group `fanout` children.
  let level = blocks.map((b, i) => ({ bbox: b.bbox, leaf: i }));
  const nodes = []; // node = {entries:[{bbox, child|leaf}] }
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += fanout) {
      const ch = level.slice(i, i + fanout);
      const bbox = [Math.min(...ch.map(c => c.bbox[0])), Math.min(...ch.map(c => c.bbox[1])), Math.max(...ch.map(c => c.bbox[2])), Math.max(...ch.map(c => c.bbox[3]))];
      nodes.push({ entries: ch }); next.push({ bbox, node: nodes.length - 1 });
    }
    level = next;
  }
  const rootIdx = nodes.length ? level[0].node : -1;
  // Layout: header | manifest | nodes (root first for the progressive read) | blocks
  const nodeSize = nodes.map(nd => nd.entries.length * DIR_ENTRY);
  const order = [rootIdx, ...nodes.map((_, i) => i).filter(i => i !== rootIdx)];
  let off = HEADER + MANIFEST; const nodeOff = {};
  for (const i of order) { nodeOff[i] = off; off += nodeSize[i]; }
  const dirBytes = off - HEADER - MANIFEST;
  const blockOff = []; for (const b of blocks) { blockOff.push(off); off += b.len; }
  return { blocks, nodes, rootIdx, nodeOff, nodeSize, blockOff, dirStart: HEADER + MANIFEST, dirBytes, total: off, n, perBlock, fanout };
}

const inter = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const PRESETS = { fullExtent: [0, 0, 1, 1], denseDetail: [0.02, 0.02, 0.07, 0.07], sparseEdge: [0.85, 0.85, 1, 1] };

function startOrigin(fx, rttMs) {
  const stats = { requests: 0, bytes: { header: 0, manifest: 0, directory: 0, tier0: 0 }, log: [] };
  const classify = (s, e) => s < HEADER ? "header" : s < fx.dirStart ? "manifest" : s < fx.dirStart + fx.dirBytes ? "directory" : "tier0";
  const srv = http.createServer((req, res) => {
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || "");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length");
    res.setHeader("Accept-Ranges", "bytes");
    if (!m) { res.writeHead(416).end(); return; }
    const s = +m[1], e = Math.min(+m[2], fx.total - 1);
    const kind = classify(s, e); stats.requests++; stats.bytes[kind] += e - s + 1;
    setTimeout(() => {
      res.writeHead(206, { "Content-Range": `bytes ${s}-${e}/${fx.total}`, "Content-Length": e - s + 1 });
      res.end(Buffer.alloc(e - s + 1));
    }, rttMs);
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r({ srv, stats, url: `http://127.0.0.1:${srv.address().port}/f.pvec` })));
}

async function get(url, s, e, st) { const r = await fetch(url, { headers: { Range: `bytes=${s}-${e}` } }); const b = await r.arrayBuffer(); return b.byteLength; }

// strategy "whole": header+manifest, whole directory, then tier0 blocks. "progressive": walk the tree.
async function bootstrap(fx, vp, strategy, rttMs) {
  const { srv, stats, url } = await startOrigin(fx, rttMs);
  const t0 = performance.now(); let rounds = 0;
  try {
    await get(url, 0, HEADER + MANIFEST - 1, stats); rounds++;            // header + manifest in one range
    let want = [];
    if (strategy === "whole") {
      await get(url, fx.dirStart, fx.dirStart + fx.dirBytes - 1, stats); rounds++;
      want = fx.blocks.map((b, i) => i).filter(i => inter(fx.blocks[i].bbox, vp));
    } else {
      let frontier = fx.rootIdx >= 0 ? [fx.rootIdx] : [];
      while (frontier.length) {
        await Promise.all(frontier.map(i => get(url, fx.nodeOff[i], fx.nodeOff[i] + fx.nodeSize[i] - 1, stats))); rounds++;
        const next = [];
        for (const i of frontier) for (const en of fx.nodes[i].entries) if (inter(en.bbox, vp)) { if (en.leaf !== undefined) want.push(en.leaf); else next.push(en.node); }
        frontier = next;
      }
    }
    // coalesce adjacent block ranges (blocks are contiguous in Morton order)
    want.sort((a, b) => a - b);
    const ranges = [];
    for (const i of want) { const s = fx.blockOff[i], e = s + fx.blocks[i].len - 1; const last = ranges[ranges.length - 1]; if (last && last[1] + 1 === s) last[1] = e; else ranges.push([s, e]); }
    await Promise.all(ranges.map(([s, e]) => get(url, s, e, stats)));
    if (ranges.length) rounds++;
    return { requests: stats.requests, bytes: stats.bytes, serialisedRoundTrips: rounds, msToFirstUsefulDrawing: +(performance.now() - t0).toFixed(1), tier0Blocks: want.length, tier0Ranges: ranges.length };
  } finally { srv.close(); }
}

const results = { platform: `${os.arch()} ${os.type()} container, node ${process.version}, host mars x64 (NAS-native)`, provisional: true, note: "synthetic container; layout not frozen until P1.8", runs: [] };
const FIXTURES = [{ n: 10_000, perBlock: 100, fanout: 16 }, { n: 200_000, perBlock: 200, fanout: 16 }, { n: 200_000, perBlock: 200, fanout: 64 }, { n: 200_000, perBlock: 1000, fanout: 16 }];
for (const f of FIXTURES) {
  const fx = buildFixture(f.n, f.perBlock, f.fanout);
  for (const [pname, vp] of Object.entries(PRESETS)) for (const strategy of ["whole", "progressive"]) {
    const r = await bootstrap(fx, vp, strategy, 0);
    results.runs.push({ fixture: { ...f, blocks: fx.blocks.length, directoryBytes: fx.dirBytes, fileBytes: fx.total }, preset: pname, strategy, rttMs: 0, ...r });
  }
}
// Latency sensitivity: one preset under 200 ms injected RTT
{
  const f = FIXTURES[1], fx = buildFixture(f.n, f.perBlock, f.fanout);
  for (const strategy of ["whole", "progressive"]) {
    const r = await bootstrap(fx, PRESETS.denseDetail, strategy, 200);
    results.runs.push({ fixture: { ...f, blocks: fx.blocks.length, directoryBytes: fx.dirBytes, fileBytes: fx.total }, preset: "denseDetail", strategy, rttMs: 200, ...r });
  }
}
fs.writeFileSync(path.join(here, "results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.runs.map(r => [r.fixture.n, r.fixture.perBlock, r.fixture.fanout, r.preset, r.strategy, r.rttMs, r.requests, r.serialisedRoundTrips, r.bytes.directory, r.bytes.tier0, r.msToFirstUsefulDrawing].join(" ")), null, 1));
