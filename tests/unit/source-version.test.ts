import { afterEach, describe, expect, it } from "vitest";
import { PVecSource } from "../../src/source/PVecSource";
import { classifyVersion } from "../../src/source/version";
import { PVecVersionError } from "../../src/source/errors";
import { buildPvec, gridSpec } from "./helpers/fixture";
import { RangeOrigin, countingFetch } from "./helpers/origin";

let origin: RangeOrigin | undefined;
afterEach(async () => origin?.stop());
const hashUrl = "https://cdn.test/plans/plan.3f2a9c1d7b8e4f60a1b2c3d4e5f60718.pvec";

describe("#18 M3.7 version identity", () => {
  it("classifies a strong ETag, an immutable URL and refuses the rest", () => {
    expect(classifyVersion("https://x.test/p.pvec", '"abc"')).toEqual({ kind: "etag", value: '"abc"' });
    expect(classifyVersion(hashUrl, 'W/"abc"')).toEqual({ kind: "immutable-url" });
    expect(classifyVersion(hashUrl, null)).toEqual({ kind: "immutable-url" });
    expect(() => classifyVersion("https://x.test/p.pvec", 'W/"abc"')).toThrow(PVecVersionError);
    expect(() => classifyVersion("https://x.test/p.pvec", null)).toThrow(/Expose-Headers/);
    try {
      classifyVersion("https://x.test/p.pvec", 'W/"abc"');
    } catch (e) {
      expect((e as PVecVersionError).code).toBe("weak-etag");
      expect((e as Error).message).toMatch(/immutable URL/);
    }
  });

  it("refuses a weak-ETag-only origin at bootstrap with a typed error", async () => {
    origin = new RangeOrigin(buildPvec(gridSpec()).bytes);
    origin.mode.etag = 'W/"weak"';
    const base = await origin.start();
    const err = await new PVecSource({ url: `${base}/p.pvec` }).bootstrap().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PVecVersionError);
    expect((err as PVecVersionError).code).toBe("weak-etag");
  });

  it("sends the pinned identity on every range request after bootstrap", async () => {
    origin = new RangeOrigin(buildPvec(gridSpec()).bytes);
    const base = await origin.start();
    const c = countingFetch();
    const s = new PVecSource({ url: `${base}/p.pvec`, fetch: c.fetch });
    await s.bootstrap();
    await s.readRange(4096, 256);
    await s.readRange(8192, 256);
    const after = c.calls.slice(1);
    expect(after.length).toBeGreaterThanOrEqual(3);
    expect(after.every((r) => r.headers["if-match"] === '"v1"')).toBe(true);
  });

  it("a swapped artifact triggers exactly one invalidation, clears all tiers, and never mixes bytes", async () => {
    const v1 = buildPvec(gridSpec({ marker: 0x11 }));
    const v2 = buildPvec(gridSpec({ marker: 0x22 }));
    origin = new RangeOrigin(v1.bytes);
    const base = await origin.start();
    const s = new PVecSource({ url: `${base}/p.pvec`, limits: { maxRetries: 1 } });
    const h1 = await s.bootstrap();
    const first = await s.readRange(h1.directory.entries[0]!.offset, 64);
    expect(first.every((b) => b === 0x11)).toBe(true);
    s.cache.put("compressed", "a", new Uint8Array(100), {});
    s.cache.put("decoded", "a", new Uint8Array(100), {});
    s.cache.put("gpu", "a", new Uint8Array(100), {});
    const events: unknown[] = [];
    const zeroAtEvent: number[][] = [];
    s.onInvalidate((e) => {
      events.push(e);
      zeroAtEvent.push((["compressed", "decoded", "gpu"] as const).map((t) => s.cache.bytes(t)));
    });
    origin.swap(v2.bytes, '"v2"');
    // Two concurrent reads both see the change.
    const results = await Promise.allSettled([
      s.readRange(h1.directory.entries[1]!.offset, 64),
      s.readRange(h1.directory.entries[2]!.offset, 64),
    ]);
    expect(results.every((r) => r.status === "rejected" && (r.reason as PVecVersionError).code === "version-changed")).toBe(true);
    expect(events).toHaveLength(1);
    expect(zeroAtEvent[0]).toEqual([0, 0, 0]);
    expect(s.stats.retries).toBe(0); // a 412 does not consume the retry budget
    const h2 = s.handle!;
    expect(h2).not.toBe(h1);
    expect(h2.version).toEqual({ kind: "etag", value: '"v2"' });
    const after = await s.readRange(h2.directory.entries[0]!.offset, 64);
    expect(after.every((b) => b === 0x22)).toBe(true);
  });

  it("treats a response whose ETag differs from the pin as a version change even if the origin ignored If-Match", async () => {
    origin = new RangeOrigin(buildPvec(gridSpec({ marker: 0x11 })).bytes);
    const base = await origin.start();
    const s = new PVecSource({ url: `${base}/p.pvec`, fetch: (i, init) => {
      const h = new Headers(init?.headers);
      h.delete("if-match"); // an intermediary that strips the precondition
      return fetch(i, { ...init, headers: h });
    } });
    const h = await s.bootstrap();
    origin.swap(buildPvec(gridSpec({ marker: 0x22 })).bytes, '"v2"');
    const err = await s.readRange(h.directory.entries[0]!.offset, 64).catch((e: unknown) => e);
    expect((err as PVecVersionError).code).toBe("version-changed");
  });
});
