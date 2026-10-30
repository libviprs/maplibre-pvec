// Runs inside the page. `PvecMlp` is the bundle of the production loader and the packed binding.
const u8 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const WORLD = [-1e12, -1e12, 1e12, 1e12];
const r3 = (x) => +x.toFixed(3);

async function main(p) {
  const out = { notes: [] };
  const t0 = performance.now();
  const module = await WebAssembly.compile(u8(p.wasm));
  out.compileMs = r3(performance.now() - t0);
  const t1 = performance.now();
  const ev = await PvecMlp.loadEvaluator({ wasmModule: module });
  out.instantiateMs = r3(performance.now() - t1);
  out.abiVersion = ev.abiVersion;
  const rt = PvecMlp.bindPacked(ev);
  const mem = ev.instance.exports.memory;
  const pages = () => mem.buffer.byteLength / 65536;

  // chain: identity source_to_map, identity map_to_screen, pixel ratio 1, a screen budget that never binds, a world budget of eps
  const worldChain = (eps) => [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1e9, eps];
  const prep = (bytes) => {
    const file = rt.open(bytes);
    if (file < 0) throw new Error(`open returned ${file}`);
    const batch = rt.queryViewport(file, ...WORLD, 1e7);
    return { file, batch, n: rt.batchLength(batch) };
  };
  const tess = (batch, chain, maxSeg, prec = "f64") => {
    const r = rt.tessellate(batch, chain, maxSeg, prec);
    if (r < 0) throw new Error(`tessellate returned ${r}`);
    const v = rt.views(r);
    const verts = v.offsets[v.offsets.length - 1];
    const failed = rt.failed(r);
    rt.release(r);
    return { verts, failed };
  };
  const timeIt = (fn, minMs, minReps) => {
    for (let i = 0; i < 3; i++) fn();
    const samples = [];
    for (let t = 0; t < 5; t++) {
      let reps = 0;
      const s = performance.now();
      do { fn(); reps++; } while (reps < minReps || performance.now() - s < minMs);
      samples.push(((performance.now() - s) * 1e6) / reps);
    }
    return { medianNsPerCall: median(samples), minNsPerCall: Math.min(...samples), maxNsPerCall: Math.max(...samples) };
  };

  // ---- M1.3: the named fixtures ----
  const TARGETS = [1e2, 1e3, 1e4, 1e5];
  out.fixtures = [];
  for (const [id, b64] of Object.entries(p.small)) {
    const { file, batch, n } = prep(u8(b64));
    const row = { id, entities: n };
    const base = tess(batch, worldChain(1e-3), 2e6);
    row.vertsAtEps1e3 = base.verts;
    // one evaluation: a batch of this fixture's entities at a drawing-sized budget, including the arrays and the release
    const single = timeIt(() => tess(batch, worldChain(1e-3), 2e6), 30, 200);
    row.singleEvaluation = { ...single, vertices: base.verts };
    // amortised: find the budget that yields about N vertices (a line has two whatever the budget), then time it
    row.amortised = [];
    for (const N of TARGETS) {
      let lo = Math.log(1e-15), hi = Math.log(1e6), best = null;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2, eps = Math.exp(mid);
        const r = tess(batch, worldChain(eps), 2e6);
        if (!best || Math.abs(r.verts - N) < Math.abs(best.verts - N)) best = { eps, ...r };
        if (r.verts > N) lo = mid; else hi = mid;
      }
      const ok = best.verts >= N * 0.5 && best.verts <= N * 2;
      const t = ok ? timeIt(() => tess(batch, worldChain(best.eps), 2e6), 30, 5) : null;
      row.amortised.push({ targetVertices: N, reachable: ok, vertices: best.verts, failed: best.failed, eps: best.eps, ...(t ? { nsPerVertex: r3(t.medianNsPerCall / best.verts), nsPerCall: Math.round(t.medianNsPerCall) } : {}) });
    }
    rt.release(batch); rt.release(file);
    out.fixtures.push(row);
  }

  // ---- packed output, large batches ----
  out.large = [];
  for (const [id, b64] of Object.entries(p.large)) {
    const bytes = u8(b64);
    const row = { id, fileBytes: bytes.length };
    let s = performance.now();
    const file = rt.open(bytes);
    row.openMs = r3(performance.now() - s);
    if (file < 0) { row.openCode = file; out.large.push(row); continue; }
    s = performance.now();
    const all = rt.queryViewport(file, ...WORLD, 1e7);
    row.queryAllMs = r3(performance.now() - s);
    row.entities = rt.batchLength(all);
    // extent from a coarse tessellation, so the viewports are in the file's own units
    const probe = rt.tessellate(all, worldChain(1e30), 2e6, "f64");
    const pv = rt.views(probe);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < pv.vertices.length; i += 2) { x0 = Math.min(x0, pv.vertices[i]); x1 = Math.max(x1, pv.vertices[i]); y0 = Math.min(y0, pv.vertices[i + 1]); y1 = Math.max(y1, pv.vertices[i + 1]); }
    rt.release(probe);
    row.extent = [x0, y0, x1, y1];
    const w = x1 - x0, h = y1 - y0, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    row.viewports = [];
    for (const f of [1, 0.25, 0.05]) {
      const box = [cx - (w * f) / 2, cy - (h * f) / 2, cx + (w * f) / 2, cy + (h * f) / 2];
      // 1000 px across the box, a quarter pixel of error
      const k = 1000 / (w * f);
      const chain = [1, 0, 0, 1, 0, 0, k, 0, 0, k, 0, 0, 1, 0.25, 1e30];
      const vp = { fraction: f };
      s = performance.now();
      const batch = rt.queryViewport(file, ...box, 1e7);
      vp.queryMs = r3(performance.now() - s);
      vp.entities = rt.batchLength(batch);
      for (const prec of ["f64", "f32"]) {
        const pagesBefore = pages();
        s = performance.now();
        const r = rt.tessellate(batch, chain, 2e6, prec);
        if (r < 0) { vp[prec] = { code: r }; continue; }
        const v = rt.views(r);
        const ms = performance.now() - s;
        vp[prec] = { tessellateMs: r3(ms), vertices: v.offsets[v.offsets.length - 1], failed: rt.failed(r), nsPerEntity: vp.entities ? Math.round((ms * 1e6) / vp.entities) : null, nsPerVertex: v.vertices.length ? Math.round((ms * 1e6) / (v.vertices.length / 2)) : null, wasmPagesGrown: pages() - pagesBefore };
        rt.release(r);
      }
      // allocation check: JS heap across repeated whole-batch calls (four typed arrays per call, whatever the entity count)
      if (f === 1 && performance.memory) {
        gc(); const h0 = performance.memory.usedJSHeapSize;
        const reps = 50;
        for (let i = 0; i < reps; i++) { const r = rt.tessellate(batch, chain, 2e6, "f64"); rt.views(r); rt.release(r); }
        const h1 = performance.memory.usedJSHeapSize; gc(); const h2 = performance.memory.usedJSHeapSize;
        vp.heap = { calls: reps, entitiesPerCall: vp.entities, growthBytes: h1 - h0, afterGcBytes: h2 - h0, bytesPerEntity: +((h1 - h0) / (reps * vp.entities)).toFixed(5) };
      }
      rt.release(batch);
      row.viewports.push(vp);
    }
    rt.release(all); rt.release(file);
    out.large.push(row);
  }

  // ---- leaks: the module's own memory across open/tessellate/release cycles ----
  {
    const bytes = u8(p.small["polyline-001"]);
    const p0 = pages();
    for (let i = 0; i < 3000; i++) { const f = rt.open(bytes); const b = rt.queryViewport(f, ...WORLD, 100); const r = rt.tessellate(b, worldChain(1e-3), 1e5, "f64"); rt.release(r); rt.release(b); rt.release(f); }
    const p1 = pages();
    for (let i = 0; i < 3000; i++) { const f = rt.open(bytes); const b = rt.queryViewport(f, ...WORLD, 100); const r = rt.tessellate(b, worldChain(1e-3), 1e5, "f64"); rt.release(r); rt.release(b); rt.release(f); }
    out.leak = { cycles: 6000, pagesBefore: p0, pagesAfterFirst3000: p1, pagesAfter6000: pages(), note: "pages are 64 KiB; no growth between the two halves means no per-call leak" };
  }
  return out;
}
