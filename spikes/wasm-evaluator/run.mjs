// Throwaway spike (M1.3, boundary cost only). The pvec evaluator WASM artifact (P7.2/P7.3) does not
// exist yet, so this measures the JS<->WASM call boundary with a hand-assembled module that exports
// add(f64,f64) and batch(ptr,n) (sum of sqrt over n packed f64). It says nothing about curve cost.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"] });
const page = await browser.newPage();
await page.setContent("<body>");
const results = { browser: `chromium ${browser.version()}`, scope: "boundary cost only; pvec evaluator WASM not available (see docs/deferred.md)", ...(await page.evaluate(async () => {
  const u = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
  const sec = (id, body) => [id, ...u(body.length), ...body];
  const vec = (items) => [...u(items.length), ...items.flat()];
  const str = s => [...u(s.length), ...[...s].map(c => c.charCodeAt(0))];
  const types = sec(1, vec([[0x60, ...vec([[0x7c], [0x7c]]), ...vec([[0x7c]])], [0x60, ...vec([[0x7f], [0x7f]]), ...vec([[0x7c]])]]));
  const funcs = sec(3, vec([[0], [1]]));
  const mem = sec(5, vec([[0x00, 0x01]]));
  const exps = sec(7, vec([[...str("add"), 0, 0], [...str("batch"), 0, 1], [...str("mem"), 2, 0]]));
  const add = [0x00, 0x20, 0, 0x20, 1, 0xa0, 0x0b];
  const body = [0x02, 0x01, 0x7f, 0x01, 0x7c, 0x02, 0x40, 0x03, 0x40, 0x20, 2, 0x20, 1, 0x4f, 0x0d, 1,
    0x20, 3, 0x20, 0, 0x20, 2, 0x41, 3, 0x74, 0x6a, 0x2b, 3, 0, 0x9f, 0xa0, 0x21, 3,
    0x20, 2, 0x41, 1, 0x6a, 0x21, 2, 0x0c, 0, 0x0b, 0x0b, 0x20, 3, 0x0b];
  const code = sec(10, vec([[...u(add.length), ...add], [...u(body.length), ...body]]));
  const bytes = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...types, ...funcs, ...mem, ...exps, ...code]);
  const { instance } = await WebAssembly.instantiate(bytes);
  const { add: wadd, batch, mem: memory } = instance.exports;
  const out = { perCall: null, batches: [], heap: null };
  // per-call overhead: 5e6 calls
  const N = 5_000_000; let acc = 0; for (let i = 0; i < 100000; i++) acc += wadd(i, 1); // warm
  let t = performance.now(); for (let i = 0; i < N; i++) acc += wadd(i, 1); const dt = performance.now() - t;
  let t2 = performance.now(); let js = 0; for (let i = 0; i < N; i++) js += i + 1; const dj = performance.now() - t2;
  out.perCall = { nsPerCall: +(dt * 1e6 / N).toFixed(2), nsPerCallPureJsLoopBaseline: +(dj * 1e6 / N).toFixed(2), sink: acc + js > 0 };
  // batches: amortised ns per point, including filling the packed input in wasm memory
  memory.grow(20);
  const f64 = new Float64Array(memory.buffer);
  for (const n of [1e2, 1e3, 1e4, 1e5]) {
    for (let i = 0; i < n; i++) f64[i] = i + 1;
    const reps = Math.max(5, Math.floor(2e7 / n)); let s = 0;
    for (let r = 0; r < 20; r++) s += batch(0, n);
    const t0 = performance.now(); for (let r = 0; r < reps; r++) s += batch(0, n); const d = performance.now() - t0;
    const t1 = performance.now(); for (let r = 0; r < reps; r++) for (let i = 0; i < n; i++) s += wadd(f64[i], 0); const d2 = performance.now() - t1;
    out.batches.push({ n, nsPerPointPacked: +(d * 1e6 / (reps * n)).toFixed(3), nsPerPointPerCall: +(d2 * 1e6 / (reps * n)).toFixed(3), sink: s > 0 });
  }
  // heap: 1e5 evaluations via the packed path, 200 repetitions; per-entity JS object allocation shows as heap growth
  for (let i = 0; i < 1e5; i++) f64[i] = i + 1;
  gc(); const h0 = performance.memory.usedJSHeapSize;
  let s = 0; for (let r = 0; r < 200; r++) s += batch(0, 1e5);
  const h1 = performance.memory.usedJSHeapSize; gc(); const h2 = performance.memory.usedJSHeapSize;
  out.heap = { evaluations: 200 * 1e5, heapBeforeBytes: h0, heapAfterBytes: h1, heapAfterGcBytes: h2, growthBytes: h1 - h0, bytesPerEvaluation: (h1 - h0) / (200 * 1e5), sink: s > 0 };
  return out;
})) };
await browser.close();
fs.writeFileSync(path.join(here, "results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 1));
