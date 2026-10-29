import { describe, expect, it } from "vitest";
import { TieredCache, type Tier } from "../../src/source/cache";

const MiB = 1024 * 1024;
const small = { compressed: 10_000, decoded: 10_000, gpu: 10_000 };
const blob = (n: number) => new Uint8Array(n);

describe("#18 M3.5 tiered cache", () => {
  it("has the documented provisional ceilings by default", () => {
    const c = new TieredCache();
    expect(c.ceiling("compressed")).toBe(64 * MiB);
    expect(c.ceiling("decoded")).toBe(128 * MiB);
    expect(c.ceiling("gpu")).toBe(128 * MiB);
  });

  it("evicts instead of growing when the ceiling is small", () => {
    const c = new TieredCache(small);
    for (let i = 0; i < 50; i++) c.put("decoded", `k${i}`, blob(1000), {});
    expect(c.bytes("decoded")).toBeLessThanOrEqual(10_000);
    expect(c.evictionLog.length).toBe(40);
  });

  it("never evicts a visible block while an off-screen object of equal or greater size is resident", () => {
    const c = new TieredCache(small);
    for (let i = 0; i < 5; i++) c.put("decoded", `vis${i}`, blob(1000), { visible: true });
    for (let i = 0; i < 5; i++) c.put("decoded", `pre${i}`, blob(1000), { visible: false });
    c.put("decoded", "vis-new", blob(1000), { visible: true });
    expect(c.has("decoded", "vis-new")).toBe(true);
    for (let i = 0; i < 5; i++) expect(c.has("decoded", `vis${i}`)).toBe(true);
    expect(c.evictionLog.every((e) => e.key.startsWith("pre"))).toBe(true);
  });

  it("setVisible demotes blocks that scrolled out of view", () => {
    const c = new TieredCache(small);
    c.put("decoded", "a", blob(5000), { visible: true });
    c.put("decoded", "b", blob(5000), { visible: true });
    c.setVisible(new Set(["b"]));
    c.put("decoded", "c", blob(5000), { visible: true });
    expect(c.has("decoded", "a")).toBe(false);
    expect(c.has("decoded", "b")).toBe(true);
  });

  it("a refined generation is never evicted in favour of its superseded preview", () => {
    const c = new TieredCache(small);
    c.put("decoded", "e7-preview", blob(1000), { entityId: 7, generation: 1, visible: true });
    c.put("decoded", "e7-refined", blob(1000), { entityId: 7, generation: 2, refined: true, visible: true });
    expect(c.has("decoded", "e7-preview")).toBe(false);
    expect(c.put("decoded", "e7-preview-again", blob(1000), { entityId: 7, generation: 1 })).toBe(false);
    // Under pressure, a preview of another entity goes before the refined generation.
    c.put("decoded", "e8-preview", blob(4000), { entityId: 8, generation: 1, visible: false });
    c.put("decoded", "x", blob(5500), { visible: false });
    expect(c.has("decoded", "e7-refined")).toBe(true);
    expect(c.has("decoded", "e8-preview")).toBe(false);
  });

  it("logs the value terms that decided each eviction, with deterministic tie-breaks", () => {
    const run = () => {
      const c = new TieredCache(small);
      for (let i = 0; i < 12; i++) c.put("compressed", `k${i}`, blob(1000), {});
      return c.evictionLog;
    };
    const log = run();
    expect(log[0]).toMatchObject({ tier: "compressed", key: "k0", bytes: 1000, terms: { visible: false, refined: false } });
    expect(typeof log[0]!.terms.lastUsed).toBe("number");
    expect(run().map((e) => e.key)).toEqual(log.map((e) => e.key));
  });

  it("refuses an object larger than the tier ceiling", () => {
    const c = new TieredCache(small);
    expect(c.put("decoded", "huge", blob(20_000), {})).toBe(false);
    expect(c.bytes("decoded")).toBe(0);
  });

  it("returns the GPU buffer count to baseline after clear, by deleting rather than dereferencing", () => {
    const live = new Set<object>();
    const gl = { createBuffer: () => { const b = {}; live.add(b); return b; }, deleteBuffer: (b: object) => void live.delete(b) };
    const baseline = live.size;
    const c = new TieredCache(small, { release: (_t, _k, payload) => gl.deleteBuffer(payload as object) });
    for (let i = 0; i < 6; i++) c.put("gpu", `b${i}`, blob(1000), { payload: gl.createBuffer() });
    expect(live.size).toBe(baseline + 6);
    c.put("gpu", "big", blob(9000), { payload: gl.createBuffer() });
    expect(live.size).toBe(baseline + 1); // evicted ones were deleted
    c.clear();
    expect(live.size).toBe(baseline);
    expect(c.bytes("gpu")).toBe(0);
  });

  it("soak: per tier bytes never pass the ceiling, accounting matches an independent total, a complete viewport stays resident", () => {
    const tiers: Tier[] = ["compressed", "decoded", "gpu"];
    const ceil = 64 * 1024;
    const c = new TieredCache({ compressed: ceil, decoded: ceil, gpu: ceil });
    let seed = 99;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const viewport = Array.from({ length: 8 }, (_, i) => `v${i}`); // 4 KiB each, 32 KiB per tier
    for (let step = 0; step < 200_000; step++) {
      const tier = tiers[Math.floor(rnd() * 3)]!;
      const isView = rnd() < 0.05;
      const key = isView ? viewport[Math.floor(rnd() * 8)]! : `p${Math.floor(rnd() * 400)}`;
      const data = blob(isView ? 4096 : 256 + Math.floor(rnd() * 3000));
      c.put(tier, `${tier}:${key}`, data, { visible: isView, payload: data });
    }
    for (const t of tiers) {
      expect(c.peak(t)).toBeLessThanOrEqual(ceil);
      let independent = 0;
      for (const k of c.keys(t)) independent += (c.payload(t, k) as Uint8Array).byteLength;
      expect(Math.abs(independent - c.bytes(t))).toBeLessThanOrEqual(c.bytes(t) * 0.05);
    }
  });
});
