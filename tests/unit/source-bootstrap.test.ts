import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PVecSource } from "../../src/source/PVecSource";
import { PVecCapabilityError, PVecFormatError } from "../../src/source/errors";
import { buildPvec, gridSpec, type FixtureSpec } from "./helpers/fixture";
import { RangeOrigin, countingFetch } from "./helpers/origin";

let origin: RangeOrigin;
let base: string;
const built = buildPvec(gridSpec());

async function start(spec: FixtureSpec = gridSpec()): Promise<void> {
  origin = new RangeOrigin(buildPvec(spec).bytes);
  base = await origin.start();
}
const restart = async (spec: FixtureSpec): Promise<void> => {
  await origin.stop();
  await start(spec);
};
beforeEach(async () => start());
afterEach(async () => origin.stop());

describe("#18 M3.2 metadata bootstrap", () => {
  it("completes inside the request and byte ceiling, asserted on the request log", async () => {
    const c = countingFetch();
    const s = new PVecSource({ url: `${base}/p.pvec`, fetch: c.fetch });
    const h = await s.bootstrap();
    // Ceiling: the first 4 KiB (header + manifest), then the block directory. Three requests at most.
    expect(c.calls.length).toBeLessThanOrEqual(3);
    expect(origin.log.map((r) => r.range)).toEqual([
      "bytes=0-4095",
      `bytes=${built.directoryOffset}-${built.directoryOffset + built.directoryLength - 1}`,
    ]);
    expect(h.requestCount).toBe(c.calls.length);
    expect(h.byteCount).toBe(4096 + built.directoryLength);
  });

  it("exposes manifest, directory accessor, version identity and counts", async () => {
    const h = await new PVecSource({ url: `${base}/p.pvec` }).bootstrap();
    expect(h.manifest.sourceBounds).toEqual({ minX: 0, minY: 0, maxX: 1000, maxY: 1000 });
    expect(h.manifest.capabilities.map((c) => c.id)).toEqual([1, 4, 5, 6]);
    expect(h.directory.entries).toHaveLength(16);
    expect(h.directory.entries[5]).toMatchObject({ cell: 5, offset: built.blockOffsets[5], length: 2048 });
    expect(h.version).toEqual({ kind: "etag", value: '"v1"' });
    expect(h.artifactLength).toBe(built.bytes.length);
  });

  it("refuses an unsupported required capability before any payload byte, naming it", async () => {
    await restart(gridSpec({ capabilities: [{ id: 1 }, { id: 99 }] }));
    const err = await new PVecSource({ url: `${base}/p.pvec` }).bootstrap().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PVecCapabilityError);
    expect((err as PVecCapabilityError).capability).toBe("capability#99");
    expect(origin.log.map((r) => r.range)).toEqual(["bytes=0-4095"]);
  });

  it("refuses a required capability declared at an unsupported major, by registry name", async () => {
    await restart(gridSpec({ capabilities: [{ id: 1, major: 2 }] }));
    const err = await new PVecSource({ url: `${base}/p.pvec` }).bootstrap().catch((e: unknown) => e);
    expect((err as PVecCapabilityError).capability).toBe("cartesian_point");
    expect(origin.log).toHaveLength(1);
  });

  it("refuses a file that needs a newer reader", async () => {
    await restart(gridSpec({ minReader: [2, 0, 0] }));
    const err = await new PVecSource({ url: `${base}/p.pvec` }).bootstrap().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PVecCapabilityError);
    expect((err as PVecCapabilityError).code).toBe("reader-too-old");
  });

  it("records unsupported optional capabilities without blocking", async () => {
    await restart(gridSpec({ capabilities: [{ id: 1 }, { id: 17, required: false }, { id: 99, required: false }] }));
    const h = await new PVecSource({ url: `${base}/p.pvec` }).bootstrap();
    expect(h.report.unsupportedOptional).toEqual([
      { id: 17, name: "hatch" },
      { id: 99, name: "capability#99" },
    ]);
    expect(origin.log).toHaveLength(2);
  });

  it("refuses a manifest pointer beyond the declared file length with a typed error", async () => {
    await restart(gridSpec({ manifestOffsetLie: 1_000_000 }));
    const err = await new PVecSource({ url: `${base}/p.pvec` }).bootstrap().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PVecFormatError);
    expect((err as PVecFormatError).code).toBe("pointer-out-of-range");
    expect(origin.log).toHaveLength(1);
  });

  it("refuses bad magic and an unsupported container major", async () => {
    const bad = buildPvec(gridSpec()).bytes.slice();
    bad[0] = 0;
    await origin.stop();
    origin = new RangeOrigin(bad);
    base = await origin.start();
    let err = await new PVecSource({ url: `${base}/p.pvec` }).bootstrap().catch((e: unknown) => e);
    expect((err as PVecFormatError).code).toBe("bad-magic");
    await origin.stop();
    const v2 = buildPvec(gridSpec()).bytes.slice();
    new DataView(v2.buffer).setUint16(8, 2, true);
    origin = new RangeOrigin(v2);
    base = await origin.start();
    err = await new PVecSource({ url: `${base}/p.pvec` }).bootstrap().catch((e: unknown) => e);
    expect((err as PVecFormatError).code).toBe("unsupported-version");
  });

  it("skips an optional unknown block kind and refuses a must-understand one", async () => {
    await restart({ blocks: [{ cell: 0, size: 64 }, { cell: 1, size: 64, kind: 9, mustUnderstand: false, capability: 99 }] });
    const h = await new PVecSource({ url: `${base}/p.pvec` }).bootstrap();
    expect(h.report.skippedBlocks).toEqual([1]);
    await restart({ blocks: [{ cell: 0, size: 64 }, { cell: 1, size: 64, kind: 9, mustUnderstand: true }] });
    const err = await new PVecSource({ url: `${base}/p.pvec` }).bootstrap().catch((e: unknown) => e);
    expect((err as PVecFormatError).code).toBe("unknown-must-understand-block");
  });

  it("is idempotent per source instance: the second call returns the same handle with no requests", async () => {
    const c = countingFetch();
    const s = new PVecSource({ url: `${base}/p.pvec`, fetch: c.fetch });
    const [a, b] = await Promise.all([s.bootstrap(), s.bootstrap()]);
    const n = c.calls.length;
    const again = await s.bootstrap();
    expect(a).toBe(b);
    expect(again).toBe(a);
    expect(c.calls.length).toBe(n);
  });
});
