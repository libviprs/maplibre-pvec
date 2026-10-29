import { describe, expect, it } from "vitest";
import { shouldMerge, RttBandwidthEstimator, OverfetchLedger, planMerges } from "../../src/source/coalesce";
import { PVecSource } from "../../src/source/PVecSource";
import { RangeScheduler } from "../../src/source/scheduler";
import { buildPvec, gridSpec } from "./helpers/fixture";
import { memoryFetch } from "./helpers/memory";

const KiB = 1024;
const MiB = 1024 * 1024;
const BW = 1250; // bytes per millisecond, 10 Mbit/s

describe("#18 M3.4 shouldMerge decision table", () => {
  const rows: [string, number, number, number, 1 | 2 | 3 | 5, boolean][] = [
    ["4 KiB gap at 200 ms RTT merges", 4 * KiB, 200, BW, 2, true],
    ["4 MiB gap at 200 ms RTT does not", 4 * MiB, 200, BW, 2, false],
    ["4 KiB gap at 5 ms RTT on visible Tier 0 does not delay it", 4 * KiB, 5, BW, 1, false],
    ["zero gap always merges", 0, 1, BW, 1, true],
    ["zero gap merges at any RTT for prefetch", 0, 50, BW, 5, true],
    ["64 KiB gap at 200 ms RTT merges for prefetch", 64 * KiB, 200, BW, 5, true],
    ["64 KiB gap at 20 ms RTT does not for visible deferred", 64 * KiB, 20, BW, 2, false],
    ["256 KiB gap at 200 ms RTT does not on a slow link", 256 * KiB, 200, 100, 3, false],
    ["256 KiB gap at 200 ms RTT merges on a fast link", 256 * KiB, 200, 12500, 3, true],
    ["1 KiB gap at 2 ms RTT merges for near-visible", 1 * KiB, 2, BW, 3, true],
    ["1 KiB gap at 1 ms RTT on class 1 does not", 1 * KiB, 1, BW, 1, false],
    ["8 KiB gap at 100 ms RTT merges on class 1", 8 * KiB, 100, BW, 1, true],
    ["unknown bandwidth of zero never merges a gap", 4 * KiB, 200, 0, 2, false],
  ];
  it.each(rows)("%s", (_n, gap, rtt, bw, cls, expected) => {
    expect(shouldMerge(gap, rtt, bw, cls)).toBe(expected);
  });
});

describe("#18 M3.4 estimator", () => {
  it("starts from the documented cold values", () => {
    const e = new RttBandwidthEstimator();
    expect(e.rttMs).toBe(100);
    expect(e.bandwidthBytesPerMs).toBe(1250);
  });
  it("converges within 25% of an injected 200 ms latency after 20 requests", () => {
    const e = new RttBandwidthEstimator();
    for (let i = 0; i < 20; i++) e.record({ ttfbMs: 200 + (i % 3) - 1, bodyMs: 10, bytes: 50_000 });
    expect(Math.abs(e.rttMs - 200)).toBeLessThan(50);
    expect(e.bandwidthBytesPerMs).toBeGreaterThan(0);
  });
  it("converges against a live origin delay too", async () => {
    const body = buildPvec(gridSpec()).bytes;
    const s = new PVecSource({ url: "https://x.test/p.pvec", fetch: memoryFetch(body, { delayMs: () => 40 }) });
    for (let i = 0; i < 20; i++) await s.readRange(i * 64, 64);
    expect(Math.abs(s.estimator.rttMs - 40)).toBeLessThan(10);
  });
});

describe("#18 M3.4 planning and ordering", () => {
  it("merges neighbours only when the guard says so, and never lets a lower class delay class 1", () => {
    const plan = planMerges(
      [
        { id: 1, offset: 0, length: 100, priority: 1 },
        { id: 2, offset: 4196, length: 100, priority: 5 },
        { id: 3, offset: 6_000_000, length: 100, priority: 2 },
      ],
      { rttMs: 5, bandwidthBytesPerMs: BW },
    );
    expect(plan.map((p) => p.members.map((m) => m.id))).toEqual([[1], [2], [3]]);
    const merged = planMerges(
      [
        { id: 1, offset: 0, length: 100, priority: 2 },
        { id: 2, offset: 4196, length: 100, priority: 2 },
      ],
      { rttMs: 200, bandwidthBytesPerMs: BW },
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ offset: 0, length: 4296, usedBytes: 200 });
  });

  it("leaves the arrival order of visible Tier 0 payloads unchanged by coalescing", async () => {
    const body = buildPvec(gridSpec()).bytes;
    const order = async (coalesce: boolean) => {
      const s = new PVecSource({
        url: "https://x.test/p.pvec",
        fetch: memoryFetch(body),
        limits: { maxConcurrentRequests: 1 },
      });
      const sch = new RangeScheduler(s, { coalesce });
      const done: number[] = [];
      const reqs = [
        { offset: 9000, priority: 1 as const, chunkOrder: 3 },
        { offset: 9200, priority: 5 as const, chunkOrder: 0 },
        { offset: 2000, priority: 1 as const, chunkOrder: 1 },
        { offset: 2200, priority: 2 as const, chunkOrder: 0 },
        { offset: 5000, priority: 1 as const, chunkOrder: 2 },
      ];
      await Promise.all(reqs.map((r) => sch.submit({ ...r, length: 100 }).then(() => r.priority === 1 && done.push(r.offset))));
      return done;
    };
    expect(await order(true)).toEqual(await order(false));
  });

  it("reports overfetch per request and in aggregate, below the ceiling on a soak", async () => {
    const body = buildPvec(gridSpec()).bytes;
    const s = new PVecSource({
      url: "https://x.test/p.pvec",
      fetch: memoryFetch(body, { delayMs: () => 50 }),
      limits: { maxConcurrentRequests: 2, maxQueuedBytes: 1e7, maxQueuedJobs: 5000 },
    });
    const sch = new RangeScheduler(s, { coalesce: true });
    for (let i = 0; i < 20; i++) await s.readRange(0, 16); // warm the RTT estimate to 50 ms
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    await Promise.all(Array.from({ length: 300 }, () => sch.submit({ offset: Math.floor(rnd() * 30000), length: 128, priority: 2 })));
    const l: OverfetchLedger = sch.overfetch;
    expect(l.requests).toBeGreaterThan(0);
    expect(l.requestedBytes).toBeGreaterThanOrEqual(l.usedBytes);
    expect(l.ratio).toBeGreaterThanOrEqual(1);
    expect(l.ratio).toBeLessThan(4); // stated ceiling, provisional until M8.6
    expect(l.perRequest.every((r) => r.requestedBytes >= r.usedBytes)).toBe(true);
  });
});
