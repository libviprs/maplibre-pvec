import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadEvaluator } from "../../src/wasm/loader";
import { REQUIRED_EXPORTS, SUPPORTED_ABI_VERSIONS, bindPacked } from "../../src/wasm/packed";
import { PVecError } from "../../src/source/errors";
import { EVALUATOR_WASM_BYTES, PROBE_WASM_BYTES } from "./helpers/probe";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const json = <T>(p: string): T => JSON.parse(readFileSync(join(root, p), "utf8")) as T;
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const pin = json<{ pvecCommit: string; abiVersion: number; wasm: { bytes: number; sha256: string } }>("wasm/pvec.pin.json");
const index = json<{
  pvecCommit: string;
  artifacts: Record<string, { bytes: number; sha256: string }>;
  notEmitted: Record<string, { status: string; reason: string }>;
}>("tests/fixtures/pvec/index.json");
const pvec = (id: string): Uint8Array => new Uint8Array(readFileSync(join(root, "tests/fixtures/pvec", `${id}.pvec`)));

// The display budget asked of the evaluator, in world units. It is a drawing budget, not a numeric-policy tolerance.
const ASKED_WORLD_ERROR = 0.01;
// source_to_map identity, map_to_screen identity, pixel ratio 1, then the screen and world budgets.
const CHAIN = [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1e9, ASKED_WORLD_ERROR];
const WORLD: [number, number, number, number] = [-1e9, -1e9, 1e9, 1e9];

async function evaluator() {
  return loadEvaluator({ wasmModule: await WebAssembly.compile(EVALUATOR_WASM_BYTES) });
}

describe("#80 the shipped evaluator is the pinned pvec build", () => {
  it("is the artifact the pin names", () => {
    expect(EVALUATOR_WASM_BYTES.length).toBe(pin.wasm.bytes);
    expect(sha(EVALUATOR_WASM_BYTES)).toBe(pin.wasm.sha256);
    expect(pin.pvecCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(index.pvecCommit).toBe(pin.pvecCommit);
  });

  it("is far more than the 68 byte boundary probe", () => {
    expect(PROBE_WASM_BYTES.length).toBe(68);
    expect(EVALUATOR_WASM_BYTES.length).toBeGreaterThan(100_000);
  });
});

describe("#80 loadEvaluator guards the real export set", () => {
  it("accepts the evaluator and reports its ABI version", async () => {
    const ev = await evaluator();
    expect(ev.abiVersion).toBe(pin.abiVersion);
    expect(SUPPORTED_ABI_VERSIONS).toContain(ev.abiVersion);
    for (const name of REQUIRED_EXPORTS) expect(ev.instance.exports, name).toHaveProperty(name);
  });

  it("refuses the boundary probe: it has no wasm_abi_version and none of the packed exports", async () => {
    const e = await loadEvaluator({ wasmModule: await WebAssembly.compile(PROBE_WASM_BYTES) }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PVecError);
    expect((e as PVecError).code).toBe("wasm_unavailable");
  });

  it("refuses a module that has the version but lost an export, and names it", async () => {
    const real = await evaluator();
    const { release: _gone, ...rest } = real.instance.exports as Record<string, unknown>;
    const e = await loadEvaluator({ instantiate: async () => ({ exports: rest }) as unknown as WebAssembly.Instance }).catch((x: unknown) => x);
    expect((e as PVecError).code).toBe("wasm_unavailable");
    expect((e as PVecError).message).toContain("release");
  });

  it("refuses an ABI version it does not know", async () => {
    const real = await evaluator();
    const exports = { ...(real.instance.exports as Record<string, unknown>), wasm_abi_version: () => 3 };
    const e = await loadEvaluator({ instantiate: async () => ({ exports }) as unknown as WebAssembly.Instance }).catch((x: unknown) => x);
    expect((e as PVecError).code).toBe("wasm_unavailable");
    expect((e as PVecError).message).toMatch(/3/);
  });
});

describe("#80 the corpus bytes", () => {
  it("are the ones the index pins, and every refusal carries pvec's own reason", () => {
    expect(Object.keys(index.artifacts).length + Object.keys(index.notEmitted).length).toBe(30);
    for (const [id, a] of Object.entries(index.artifacts)) {
      const b = pvec(id);
      expect(b.length, id).toBe(a.bytes);
      expect(sha(b), id).toBe(a.sha256);
    }
    for (const [id, n] of Object.entries(index.notEmitted)) expect(n.reason, id).toContain(id);
  });

  it("has real bytes for 28 fixtures and says why the other 2 have none", () => {
    expect(Object.keys(index.artifacts)).toHaveLength(28);
    expect(Object.keys(index.notEmitted).sort()).toEqual(["near-singular-001", "translation-001"]);
  });
});

describe("#80 every corpus artifact through the real evaluator", () => {
  it("opens, queries, tessellates into four arrays and releases", async () => {
    const rt = bindPacked(await evaluator());
    for (const id of Object.keys(index.artifacts)) {
      const file = rt.open(pvec(id));
      expect(file, id).toBeGreaterThanOrEqual(0);
      const batch = rt.queryViewport(file, ...WORLD, 1000);
      const n = rt.batchLength(batch);
      expect(n, id).toBeGreaterThan(0);
      expect(rt.batchTruncated(batch), id).toBe(false);
      const out = rt.tessellate(batch, CHAIN, 100_000, "f64");
      const v = rt.views(out);
      expect(v.offsets.length, id).toBe(n + 1);
      expect(v.entityIds.length, id).toBe(n);
      expect(v.styleRefs.length, id).toBe(n);
      expect(v.vertices.length % 2, id).toBe(0);
      expect(v.offsets[n], id).toBe(v.vertices.length / 2);
      expect(rt.failed(out), id).toBe(0);
      expect(rt.conformance(out), id).toBe(1);
      for (const h of [out, batch, file]) expect(rt.release(h), id).toBe(0);
      expect(rt.release(file), id).toBe(-1);
    }
  });

  it("gives back a handle whose generation has grown into the sign bit as the unsigned number it is (pvec#203)", async () => {
    const real = await evaluator();
    const wrapped = { ...(real.instance.exports as Record<string, unknown>), open: () => -2147483646, query_viewport: () => -2147483645, release: (h: number) => (h === 2147483650 || h === -2147483646 ? 0 : -1) };
    const rt = bindPacked({ ...real, instance: { exports: wrapped } as unknown as WebAssembly.Instance });
    const file = rt.open(new Uint8Array([0]));
    expect(file).toBe(2147483650);
    expect(rt.queryViewport(file, 0, 0, 1, 1, 1)).toBe(2147483651);
    expect(rt.release(file)).toBe(0);
  });

  it("returns a negative code and no object for bytes that are not a PVec file", async () => {
    const rt = bindPacked(await evaluator());
    expect(rt.open(new Uint8Array([1, 2, 3, 4]))).toBe(-4);
    expect(rt.release(12345)).toBe(-1);
  });

  it("gives the exact line back and a circle within the error budget", async () => {
    const rt = bindPacked(await evaluator());
    const tess = (id: string) => {
      const f = rt.open(pvec(id));
      const out = rt.tessellate(rt.queryViewport(f, ...WORLD, 10), CHAIN, 100_000, "f64");
      return rt.views(out);
    };
    const line = tess("line-001");
    expect(line.vertices.length).toBe(4);
    const circle = tess("circle-001");
    const pts = Array.from({ length: circle.vertices.length / 2 }, (_, i) => [circle.vertices[2 * i]!, circle.vertices[2 * i + 1]!]);
    expect(pts.length).toBeGreaterThan(8);
    // circle-001 is centre (1.5, -2.25), radius 2.75 (expected.math.json). Every chord stays within the
    // world error that was asked for, and no vertex strays from the circle by more than that either.
    for (const [x, y] of pts) expect(Math.abs(Math.hypot(x! - 1.5, y! + 2.25) - 2.75)).toBeLessThanOrEqual(ASKED_WORLD_ERROR);
    for (let i = 0; i + 1 < pts.length; i++) {
      const mx = (pts[i]![0]! + pts[i + 1]![0]!) / 2, my = (pts[i]![1]! + pts[i + 1]![1]!) / 2;
      expect(2.75 - Math.hypot(mx - 1.5, my + 2.25)).toBeLessThanOrEqual(ASKED_WORLD_ERROR);
    }
  });

  it("makes stale views detectable: memory growth bumps the epoch", async () => {
    const rt = bindPacked(await evaluator());
    const f = rt.open(pvec("polyline-001"));
    const out = rt.tessellate(rt.queryViewport(f, ...WORLD, 10), CHAIN, 1000, "f64");
    const v = rt.views(out);
    expect(v.current()).toBe(true);
    rt.forceGrow();
    expect(v.current()).toBe(false);
    expect(rt.views(out).current()).toBe(true);
  });

  it("returns f32 vertices relative to an origin when asked", async () => {
    const rt = bindPacked(await evaluator());
    const f = rt.open(pvec("large-coords-001"));
    const out = rt.tessellate(rt.queryViewport(f, ...WORLD, 10), CHAIN, 1000, "f32");
    expect(rt.views(out).vertices).toBeInstanceOf(Float32Array);
    expect(Number.isFinite(rt.origin(out)[0])).toBe(true);
  });
});
