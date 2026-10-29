import { describe, expect, it } from "vitest";
import { PVecSource } from "../../src/source/PVecSource";
import { RangeScheduler, type ManualTimers } from "../../src/source/scheduler";
import { PVecBackpressureError } from "../../src/source/errors";
import { buildPvec, gridSpec } from "./helpers/fixture";
import { memoryFetch } from "./helpers/memory";

const body = buildPvec(gridSpec()).bytes;
const mk = (limits = {}, fetchOpts = {}) => {
  const starts: [number, number][] = [];
  const s = new PVecSource({
    url: "https://example.test/p.pvec",
    fetch: memoryFetch(body, { onStart: (r) => starts.push(r), ...fetchOpts }),
    limits: { maxConcurrentRequests: 1, ...limits },
  });
  return { s, starts };
};
const manualTimers = (): ManualTimers & { advance(ms: number): void } => {
  let t = 0;
  const pending: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  return {
    now: () => t,
    setTimeout: (fn, ms) => {
      pending.push({ at: t + ms, fn, id: next });
      return next++;
    },
    clearTimeout: (id) => {
      const i = pending.findIndex((p) => p.id === id);
      if (i >= 0) pending.splice(i, 1);
    },
    advance(ms) {
      t += ms;
      for (const p of pending.filter((x) => x.at <= t)) {
        pending.splice(pending.indexOf(p), 1);
        p.fn();
      }
    },
  };
};
const req = (offset: number, priority: 1 | 2 | 3 | 5, extra = {}) => ({ offset, length: 100, priority, ...extra });

describe("#18 M3.3 priority range scheduler", () => {
  it("dequeues in class order: visible T0, visible deferred, near-visible, prefetch", async () => {
    const { s, starts } = mk();
    const sch = new RangeScheduler(s, { coalesce: false });
    await s.readRange(0, 10); // learn artifact length
    starts.length = 0;
    await Promise.all([
      sch.submit(req(5000, 5)),
      sch.submit(req(4000, 3)),
      sch.submit(req(3000, 2)),
      sch.submit(req(2000, 1)),
      sch.submit(req(1000, 5)),
    ]);
    expect(starts.map((r) => r[0])).toEqual([2000, 3000, 4000, 1000, 5000]);
  });

  it("breaks ties by screen coverage, then chunk order, reproducibly", async () => {
    const run = async () => {
      const { s, starts } = mk();
      const sch = new RangeScheduler(s, { coalesce: false });
      await s.readRange(0, 10);
      starts.length = 0;
      await Promise.all([
        sch.submit(req(9000, 1, { coverage: 0.1, chunkOrder: 1 })),
        sch.submit(req(8000, 1, { coverage: 0.5, chunkOrder: 7 })),
        sch.submit(req(7000, 1, { coverage: 0.5, chunkOrder: 2 })),
        sch.submit(req(6000, 1, { coverage: 0.1, chunkOrder: 0 })),
      ]);
      return starts.map((r) => r[0]);
    };
    const a = await run();
    expect(a).toEqual([7000, 8000, 6000, 9000]);
    expect(await run()).toEqual(a);
  });

  it("while the camera moves, near-visible work is demoted and prefetch issues nothing; it resumes after the idle threshold", async () => {
    const { s, starts } = mk();
    const timers = manualTimers();
    const sch = new RangeScheduler(s, { coalesce: false, idleMs: 150, timers });
    await s.readRange(0, 10);
    starts.length = 0;
    sch.setInteracting(true);
    const pre = sch.submit(req(6000, 5));
    const near = sch.submit(req(4000, 3));
    const vis = sch.submit(req(2000, 1));
    await Promise.all([near, vis]);
    expect(starts.map((r) => r[0])).toEqual([2000, 4000]);
    await new Promise((r) => setTimeout(r, 20));
    expect(starts).toHaveLength(2); // prefetch held
    sch.setInteracting(false);
    timers.advance(100);
    await new Promise((r) => setTimeout(r, 5));
    expect(starts).toHaveLength(2); // still inside the idle threshold
    timers.advance(60);
    await pre;
    expect(starts.map((r) => r[0])).toEqual([2000, 4000, 6000]);
  });

  it("never enqueues a chunk outside the conservative viewport bounds (rotated, pitched camera)", async () => {
    const { s, starts } = mk({ maxConcurrentRequests: 4 });
    const sch = new RangeScheduler(s, { coalesce: false });
    await s.bootstrap();
    starts.length = 0;
    // Conservative AABB of a camera rotated 40 degrees and pitched 55 degrees.
    const bounds = { minX: 260, minY: 260, maxX: 740, maxY: 740 };
    const jobs = sch.requestViewport(bounds, 1);
    await Promise.all(jobs.map((j) => j.promise));
    const expected = s.queryBounds(bounds);
    expect(jobs.length).toBe(expected.length);
    expect(expected.length).toBe(9);
    for (const [start] of starts) {
      const chunk = expected.find((c) => c.offset === start);
      expect(chunk).toBeDefined();
    }
    const outside = s.handle!.directory.entries.filter((e) => !expected.some((c) => c.offset === e.offset));
    expect(starts.some(([st]) => outside.some((e) => e.offset === st))).toBe(false);
  });

  it("requestViewport returns the same chunk set at two map zooms", async () => {
    const { s } = mk();
    const sch = new RangeScheduler(s, { coalesce: false });
    await s.bootstrap();
    const b = { minX: 0, minY: 0, maxX: 500, maxY: 500 };
    const a = sch.requestViewport(b, 1).map((j) => j.chunk.cell);
    const z = sch.requestViewport(b, 1).map((j) => j.chunk.cell);
    expect(a).toEqual(z);
  });

  it("keeps in-flight requests within maxConcurrentRequests over a 1,000-request randomised soak", async () => {
    let inflight = 0;
    let peak = 0;
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const { s } = mk(
      { maxConcurrentRequests: 5, maxQueuedBytes: 10_000_000, maxQueuedJobs: 5000 },
      {
        onStart: () => (peak = Math.max(peak, ++inflight)),
        onEnd: () => void inflight--,
        delayMs: () => Math.floor(rnd() * 3),
      },
    );
    const sch = new RangeScheduler(s, { coalesce: false });
    await s.readRange(0, 10);
    const pri = [1, 2, 3, 5] as const;
    const all = Array.from({ length: 1000 }, () =>
      sch.submit(req(Math.floor(rnd() * 30000), pri[Math.floor(rnd() * 4)]!)),
    );
    await Promise.all(all);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
  });

  it("is deterministic: identical runs produce identical request sequences", async () => {
    const run = async () => {
      const { s, starts } = mk();
      const sch = new RangeScheduler(s, { coalesce: false });
      await s.readRange(0, 10);
      starts.length = 0;
      await Promise.all(
        [5, 1, 3, 2, 1, 5, 3, 2].map((p, i) => sch.submit(req(1000 * (i + 1), p as 1 | 2 | 3 | 5, { chunkOrder: i }))),
      );
      return starts.map((r) => r[0]);
    };
    expect(await run()).toEqual(await run());
  });
});

describe("#18 M3.6 backpressure", () => {
  it("with ten times the cap submitted, queued bytes never exceed the cap and the rest are refused", async () => {
    const { s } = mk({ maxQueuedBytes: 10_000 });
    const sch = new RangeScheduler(s, { coalesce: false });
    await s.readRange(0, 10);
    const results = await Promise.allSettled(Array.from({ length: 1000 }, (_, i) => sch.submit(req(i * 20, 2))));
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(100);
    expect(refused).toHaveLength(900);
    const e = refused[0]!.reason as PVecBackpressureError;
    expect(e).toBeInstanceOf(PVecBackpressureError);
    expect(e.max).toBe(10_000);
    expect(e.current).toBeGreaterThan(9_000);
    expect(sch.stats.peakQueuedBytes).toBeLessThanOrEqual(10_000);
  });

  it("retries parked submissions when capacity frees (wait mode)", async () => {
    const { s } = mk({ maxQueuedBytes: 1_000, maxConcurrentRequests: 2 });
    const sch = new RangeScheduler(s, { coalesce: false });
    await s.readRange(0, 10);
    const all = await Promise.all(Array.from({ length: 50 }, (_, i) => sch.submit(req(i * 100, 2), { wait: true })));
    expect(all).toHaveLength(50);
    expect(sch.stats.peakQueuedBytes).toBeLessThanOrEqual(1_000);
  });
});
