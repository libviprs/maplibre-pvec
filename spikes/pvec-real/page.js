// Runs inside the page. `PvecMlp` is the bundle of the production loader and the packed binding.
const u8 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const WORLD = [-1e12, -1e12, 1e12, 1e12];
const r3 = (x) => +x.toFixed(3);

async function main(p) {
  const out = {};
  const want = (name) => !p.sections || p.sections.includes(name);
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
    // Released in groups of 256 so one slot is not recycled on every call: pvec-wasm handles carry a 16 bit
    // generation, and from generation 0x8000 on a handle no longer fits the i32 the exports return
    // (libviprs/pvec, handle generation overflow). Spreading the reuse keeps this run clear of it.
    held.push(r);
    if (held.length >= 256) flush();
    return { verts, failed };
  };
  const held = [];
  const flush = () => { while (held.length) rt.release(held.pop()); };
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
  for (const [id, b64] of want('fixtures') ? Object.entries(p.small) : []) {
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
    flush();
    rt.release(batch); rt.release(file);
    out.fixtures.push(row);
  }

  // ---- packed output, large batches ----
  out.large = [];
  for (const [id, b64] of want('large') ? Object.entries(p.large) : []) {
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
  // ---- M1.5: preview error accounting and viewport coverage, against a tight reference tessellation ----
  const polys = (v) => {
    const o = [];
    for (let i = 0; i + 1 < v.offsets.length; i++) {
      const pts = [];
      for (let k = v.offsets[i]; k < v.offsets[i + 1]; k++) pts.push([v.vertices[2 * k], v.vertices[2 * k + 1]]);
      o.push({ id: v.entityIds[i], pts });
    }
    return o;
  };
  const segDist = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  const distToPoly = (p, pts) => {
    let d = Infinity;
    if (pts.length === 1) return Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]);
    for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, segDist(p[0], p[1], pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
    return d;
  };
  const hausdorff = (a, b) => {
    let d = 0;
    for (const p of a) d = Math.max(d, distToPoly(p, b));
    for (const p of b) d = Math.max(d, distToPoly(p, a));
    return d;
  };
  const segHitsBox = (a, b, [x0, y0, x1, y1]) => {
    if (Math.max(a[0], b[0]) < x0 || Math.min(a[0], b[0]) > x1 || Math.max(a[1], b[1]) < y0 || Math.min(a[1], b[1]) > y1) return false;
    const inside = (p) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
    if (inside(a) || inside(b)) return true;
    const edges = [[[x0, y0], [x1, y0]], [[x1, y0], [x1, y1]], [[x1, y1], [x0, y1]], [[x0, y1], [x0, y0]]];
    const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    return edges.some(([c, d]) => cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0);
  };
  const polyHitsBox = (pts, box) => pts.length === 1 ? pts[0][0] >= box[0] && pts[0][0] <= box[2] && pts[0][1] >= box[1] && pts[0][1] <= box[3] : pts.some((q, i) => i > 0 && segHitsBox(pts[i - 1], q, box));
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const account = (id, bytes, boxes, refRel, previewRels, hausMax) => {
    const { file, batch, n } = prep(bytes);
    const row = { id, entities: n };
    // A tight budget over a whole file can need more vertices than a result may hold (code -11, libviprs/pvec#236). The file is then
    // asked for in a 16 by 16 grid of boxes over the extent found so far, and an entity that several boxes meet is kept once.
    let extentSoFar = null;
    const grab = (b, eps) => {
      const r = rt.tessellate(b, worldChain(eps), 5e6, "f64");
      if (r >= 0) { const v = rt.views(r); const o = polys(v); rt.release(r); return o; }
      if (r !== -11 || !extentSoFar) throw new Error(`tessellate returned ${r}`);
      const [gx0, gy0, gx1, gy1] = extentSoFar, N = 16, byId = new Map();
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        const vb = rt.queryViewport(file, gx0 + (gx1 - gx0) * i / N, gy0 + (gy1 - gy0) * j / N, gx0 + (gx1 - gx0) * (i + 1) / N, gy0 + (gy1 - gy0) * (j + 1) / N, 1e7);
        const rr = rt.tessellate(vb, worldChain(eps), 5e6, "f64");
        if (rr < 0) throw new Error(`a piece of the grid was refused (${rr})`);
        for (const e of polys(rt.views(rr))) if (!byId.has(e.id)) byId.set(e.id, e);
        rt.release(rr); rt.release(vb);
      }
      return [...byId.values()].sort((a, c) => a.id - c.id);
    };
    // The extent comes from the union of a few coarse-to-moderate tessellations: at a huge budget a full circle is
    // a single point, which would make the extent zero.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const eps of [1e30, 1e3, 1, 1e-2]) {
      for (const e of grab(batch, eps)) for (const [x, y] of e.pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      extentSoFar = [x0, y0, x1, y1];
    }
    const ext = Math.max(x1 - x0, y1 - y0, 1e-9);
    extentSoFar = [x0, y0, x1, y1];
    row.extent = [x0, y0, x1, y1];
    const ref = grab(batch, ext * refRel);
    row.referenceBudget = ext * refRel;
    // preview error accounting
    row.previews = [];
    for (const rel of previewRels) {
      const eps = ext * rel;
      const pv = grab(batch, eps);
      let worst = 0, total = 0, vertsRef = 0, vertsPv = 0;
      const sample = ref.length > hausMax ? ref.map((_, i) => i).filter((i) => i % Math.ceil(ref.length / hausMax) === 0) : ref.map((_, i) => i);
      for (const i of sample) {
        const d = hausdorff(pv[i].pts, ref[i].pts);
        worst = Math.max(worst, d); total++;
      }
      for (const e of ref) vertsRef += e.pts.length;
      for (const e of pv) vertsPv += e.pts.length;
      row.previews.push({ declaredErrorWorld: eps, measuredMaxWorld: worst, ratio: eps > 0 ? +(worst / eps).toFixed(4) : null, entitiesChecked: total, withinDeclared: worst <= eps * 1.0000001 + row.referenceBudget, vertices: vertsPv, referenceVertices: vertsRef });
    }
    // viewport coverage: every entity whose reference polyline meets the box has to be in the batch
    row.coverage = { boxes: 0, entitiesMeetingBox: 0, missing: 0, extraKept: 0 };
    for (const f of boxes) {
      const bw = (x1 - x0) * f, bh = (y1 - y0) * f;
      const bx = x0 + rnd() * ((x1 - x0) - bw), by = y0 + rnd() * ((y1 - y0) - bh);
      const box = f >= 1 ? [x0 - 1, y0 - 1, x1 + 1, y1 + 1] : [bx, by, bx + bw, by + bh];
      const vb = rt.queryViewport(file, ...box, 1e7);
      const got = new Set(grab(vb, ext * 1e-2).map((e) => e.id));
      rt.release(vb);
      const want = new Set(ref.filter((e) => polyHitsBox(e.pts, box)).map((e) => e.id));
      let missing = 0; for (const w of want) if (!got.has(w)) missing++;
      row.coverage.boxes++; row.coverage.entitiesMeetingBox += want.size; row.coverage.missing += missing; row.coverage.extraKept += got.size - (want.size - missing);
    }
    rt.release(batch); rt.release(file);
    return row;
  };
  out.previewAccounting = [];
  for (const [id, b64] of want('previews') ? Object.entries(p.small) : []) out.previewAccounting.push(account(id, u8(b64), [1, 0.5, 0.25, 0.1, 0.1, 0.05, 0.05, 0.02], 1e-7, [1e-1, 1e-2, 1e-3], 1000));
  out.previewAccountingLarge = [];
  for (const [id, b64] of want('previews') ? Object.entries(p.large) : []) out.previewAccountingLarge.push(account(id, u8(b64), [1, 0.25, 0.05, 0.01], 1e-6, [1e-3], 300));

  // ---- M1.5 with the real Tier 0 stream and the spatial directory (ABI 2) ----
  // Slices: the layer's own cursor under the production decoder with its real clock. A slice is what decodeSlice
  // returns after its 8 ms budget, so the longest slice is the number the freeze condition asks about. The cost
  // of opening the file in the evaluator is the cursor's own first step and is reported on its own.
  out.tier0Slices = [];
  out.tier0Stream = [];
  // One row: the cursor drained by the production decoder, each slice timed with the real clock.
  const sliceRow = (id, bytes, extent, leaves, cursorName, make) => {
    const s0 = performance.now();
    const cursor = make(ev, bytes, extent);
    const openMs = performance.now() - s0;
    const dec = new PvecMlp.Tier0Decoder();
    const times = [];
    let entities = 0;
    // A cursor that does not say where its blocks end is one block, so a file over DEFAULTS.maxEntitiesPerBlock is refused by the decoder. That is recorded, not hidden.
    let refused;
    try {
      for (let guard = 0; guard < 1e6; guard++) {
        const a = performance.now();
        const slice = dec.decodeSlice(cursor);
        times.push(performance.now() - a);
        if (!slice) break;
        entities += slice.draws.length;
      }
    } catch (e) {
      refused = String(e && e.message || e);
    }
    cursor.close();
    const sorted = [...times].sort((x, y) => x - y);
    out.tier0Slices.push({ id, cursor: cursorName, leaves, entities, slices: Math.max(0, times.length - 1), maxSliceMs: r3(Math.max(...times)), p99SliceMs: r3(sorted[Math.floor(times.length * 0.99)]), overBudget: times.filter((t) => t > 8).length, medianSliceMs: r3(median(times)), totalMs: r3(times.reduce((x, y) => x + y, 0)), openMs: r3(openMs), ...(refused ? { refused } : {}), platform: 'chromium, ' + navigator.userAgent.slice(0, 60) });
  };
  const tier0Extent = (bytes) => {
    const f0 = rt.open(bytes);
    const extent = [0, 1, 2, 3].map((n) => rt.directoryBound(f0, n));
    const leaves = rt.directoryStat(f0, 1);
    rt.release(f0);
    return { extent, leaves };
  };
  // The layer's cursor is timed for every file first, then the cursor of before #125: the older cursor leaves a large heap of garbage
  // behind (it decodes a file in tens of thousands of slices), and a collection of it must not land in a slice of the cursor under test.
  for (const [id, b64] of want('tier0') ? Object.entries(p.tier0) : []) {
    const bytes = u8(b64);
    const { extent, leaves } = tier0Extent(bytes);
    sliceRow(id, bytes, extent, leaves, 'leaves (#125)', PvecMlp.tier0CursorOver);
  }
  for (const [id, b64] of want('tier0') ? Object.entries(p.tier0) : []) {
    const bytes = u8(b64);
    const { extent, leaves } = tier0Extent(bytes);
    sliceRow(id, bytes, extent, leaves, 'boxes (before #125)', PvecMlp.tier0CursorBefore);
  }
  for (const [id, b64] of want('tier0') ? Object.entries(p.tier0) : []) {
    const bytes = u8(b64);
    // Stream audit: entries + uncovered is the window's entity count, and every preview stays within its declared error of a tight reference.
    const file = rt.open(bytes);
    const row = { id, directory: rt.directoryStat(file, 0) === 1, windows: [], coverageMissing: 0, previews: [] };
    const b = [0, 1, 2, 3].map((n) => rt.directoryBound(file, n));
    const w = b[2] - b[0], h = b[3] - b[1];
    // The reference is a tight tessellation, one millionth of the extent like the preview accounting above (an absolute 1e-6 on this file made the module panic with a capacity overflow instead of refusing).
    const all = rt.queryViewport(file, ...WORLD, 1e7);
    const refT = rt.tessellate(all, worldChain(Math.max(w, h) * 1e-6), 5e6, 'f64');
    if (refT < 0) throw new Error('reference tessellation returned ' + refT);
    const rv = rt.views(refT);
    const refById = new Map(polys(rv).map((e) => [e.id, e.pts]));
    rt.release(refT); rt.release(all);
    let worst = 0, checked = 0, within = true;
    for (const f of [1, 0.25, 0.05]) {
      const box = f >= 1 ? [b[0] - 1, b[1] - 1, b[2] + 1, b[3] + 1] : [b[0] + w * (0.5 - f / 2), b[1] + h * (0.5 - f / 2), b[0] + w * (0.5 + f / 2), b[1] + h * (0.5 + f / 2)];
      const t = rt.tier0Viewport(file, ...box);
      const q = rt.queryViewport(file, ...box, 1e7);
      const entries = rt.tier0Stat(t, 0), uncovered = rt.tier0Stat(t, 4);
      const n = rt.batchLength(q);
      const missing = Math.abs(entries + uncovered - n);
      row.coverageMissing += missing;
      row.windows.push({ fraction: f, entries, exact: rt.tier0Stat(t, 1), previews: rt.tier0Stat(t, 2), infeasible: rt.tier0Stat(t, 3), uncovered, leavesRead: rt.tier0Stat(t, 5), leavesWithoutBlock: rt.tier0Stat(t, 6), entities: n, missing });
      const v = rt.tier0Views(t);
      const step = Math.max(1, Math.ceil(v.ids.length / 300));
      for (let i = 0; i < v.ids.length; i += step) {
        if (v.codes[i] !== 1 && v.codes[i] !== 2) continue;
        const pv = [];
        for (let k = v.offsets[i]; k < v.offsets[i + 1]; k++) pv.push([v.vertices[2 * k], v.vertices[2 * k + 1]]);
        const ref = refById.get(v.ids[i]);
        if (!ref) continue;
        // one way: every point of the curve is within the declared error of the preview polyline
        let d = 0;
        for (const q of ref) d = Math.max(d, distToPoly(q, pv));
        checked++;
        worst = Math.max(worst, d / Math.max(v.errors[i], 1e-300));
        if (d > v.errors[i] * 1.0000001 + 1e-5) within = false;
      }
      rt.release(t); rt.release(q);
    }
    row.previews.push({ entitiesChecked: checked, worstMeasuredOverDeclared: r3(worst), withinDeclared: within });
    rt.release(file);
    out.tier0Stream.push(row);
  }

  // ---- leaks: the module's own memory across open/tessellate/release cycles ----
  if (want('leak')) {
    const bytes = u8(p.small["polyline-001"]);
    const p0 = pages();
    for (let i = 0; i < 3000; i++) { const f = rt.open(bytes); const b = rt.queryViewport(f, ...WORLD, 100); const r = rt.tessellate(b, worldChain(1e-3), 1e5, "f64"); rt.release(r); rt.release(b); rt.release(f); }
    const p1 = pages();
    for (let i = 0; i < 3000; i++) { const f = rt.open(bytes); const b = rt.queryViewport(f, ...WORLD, 100); const r = rt.tessellate(b, worldChain(1e-3), 1e5, "f64"); rt.release(r); rt.release(b); rt.release(f); }
    out.leak = { cycles: 6000, pagesBefore: p0, pagesAfterFirst3000: p1, pagesAfter6000: pages(), note: "pages are 64 KiB; no growth between the two halves means no per-call leak" };
  }
  return out;
}
