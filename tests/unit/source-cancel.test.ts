import { describe, expect, it } from "vitest";
import { PVecSource } from "../../src/source/PVecSource";
import { RangeScheduler } from "../../src/source/scheduler";
import { JobTracker } from "../../src/source/cancel";
import { buildPvec, gridSpec } from "./helpers/fixture";
import { memoryFetch } from "./helpers/memory";

const body = buildPvec(gridSpec()).bytes;

describe("#18 M3.6 cancellation", () => {
  it("fires every superseded request's AbortSignal after a rapid pan, and no aborted response reaches the buffer path", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    const signals: AbortSignal[] = [];
    const inner = memoryFetch(body, { delayMs: () => 30 });
    const s = new PVecSource({
      url: "https://x.test/p.pvec",
      fetch: ((i: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal) signals.push(init.signal);
        return inner(i, init);
      }) as typeof fetch,
      limits: { maxConcurrentRequests: 4 },
    });
    const sch = new RangeScheduler(s, { coalesce: false });
    const tracker = new JobTracker();
    const delivered: string[] = [];
    const outcomes = Array.from({ length: 12 }, (_, i) =>
      tracker.run(`chunk${i}`, (signal) => sch.submit({ offset: i * 2000, length: 500, priority: 2, signal }), (bytes) => {
        delivered.push(`chunk${i}:${bytes.length}`);
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    tracker.supersede(new Set()); // pan away: nothing visible any more
    const res = await Promise.all(outcomes);
    await new Promise((r) => setTimeout(r, 50));
    process.off("unhandledRejection", onUnhandled);
    expect(res.every((r) => r === "aborted")).toBe(true);
    expect(delivered).toEqual([]);
    expect(signals).toHaveLength(4); // only the in-flight ones ever reached fetch
    expect(signals.every((sig) => sig.aborted)).toBe(true);
    expect(unhandled).toEqual([]);
    expect(tracker.waste.abortedRequests).toBe(12);
  });

  it("keeps work for chunks that are still visible", async () => {
    const s = new PVecSource({ url: "https://x.test/p.pvec", fetch: memoryFetch(body, { delayMs: () => 10 }) });
    const sch = new RangeScheduler(s, { coalesce: false });
    const tracker = new JobTracker();
    const got: string[] = [];
    const a = tracker.run("a", (signal) => sch.submit({ offset: 0, length: 64, priority: 1, signal }), () => void got.push("a"));
    const b = tracker.run("b", (signal) => sch.submit({ offset: 64, length: 64, priority: 1, signal }), () => void got.push("b"));
    tracker.supersede(new Set(["a"]));
    expect(await Promise.all([a, b])).toEqual(["done", "aborted"]);
    expect(got).toEqual(["a"]);
  });

  it("discards a result carrying an older generation, and records the waste", async () => {
    const tracker = new JobTracker();
    const delivered: number[] = [];
    const slow = tracker.run("c", async () => {
      await new Promise((r) => setTimeout(r, 10));
      return new Uint8Array(500);
    }, (b) => void delivered.push(b.length));
    tracker.bumpGeneration(); // a newer generation of the same entity was requested meanwhile
    expect(await slow).toBe("stale");
    expect(delivered).toEqual([]);
    expect(tracker.waste.bytes).toBe(500);
    tracker.recordDecode(12.5, true);
    expect(tracker.waste.decodeMs).toBeCloseTo(12.5);
  });

  it("accept() is the single stale-generation gate", () => {
    const tracker = new JobTracker();
    const g = tracker.generation;
    expect(tracker.accept(g)).toBe(true);
    tracker.bumpGeneration();
    expect(tracker.accept(g)).toBe(false);
    expect(tracker.accept(tracker.generation)).toBe(true);
  });

  it("a real error is not swallowed as an abort", async () => {
    const tracker = new JobTracker();
    await expect(tracker.run("x", async () => { throw new Error("boom"); }, () => undefined)).rejects.toThrow("boom");
  });

  it("pan waste stays below a stated ceiling", async () => {
    const s = new PVecSource({ url: "https://x.test/p.pvec", fetch: memoryFetch(body, { delayMs: () => 20 }), limits: { maxConcurrentRequests: 2 } });
    const sch = new RangeScheduler(s, { coalesce: false });
    const tracker = new JobTracker();
    const jobs = Array.from({ length: 20 }, (_, i) =>
      tracker.run(`c${i}`, (signal) => sch.submit({ offset: i * 1000, length: 1000, priority: 2, signal }), () => undefined),
    );
    await new Promise((r) => setTimeout(r, 25));
    tracker.supersede(new Set(["c0", "c1", "c2", "c3"]));
    await Promise.all(jobs);
    // Ceiling: 20 KB requested in total, at most the already-completed responses may be wasted.
    expect(tracker.waste.bytes).toBeLessThanOrEqual(4000);
  });
});
