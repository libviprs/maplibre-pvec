import { describe, expect, it } from 'vitest';
import { RefineQueue, estimateCostMs, planPieces, type Candidate } from '../../../src/refine/queue';
import { QUEUE_DEFAULTS } from '../../../src/config/defaults';
import { isEntityVisible } from '../../../src/render/cull';
import { makeHarness, pipelineAt, FRAME_MS } from '../helpers/refine_harness';
import { rng } from '../helpers/rng';

const cand = (id: number, areaPx: number, errorPx: number, over: Partial<Candidate> = {}): Candidate => ({
  entityId: id, generation: 1, transformEpoch: 0, visible: true, areaPx, errorPx, targetPx: 0.5,
  costMs: 5, navigating: false, ...over,
});

describe('M6.4 priority', () => {
  it('a planted large high-error curve is in the first 8 dispatched among 10,000 small ones', () => {
    const q = new RefineQueue();
    const r = rng(9);
    for (let i = 0; i < 10_000; i++) q.offer(cand(i, 50 + r() * 400, 1.1 + r()));
    q.offer(cand(99_999, 250_000, 40));
    const first = Array.from({ length: 8 }, () => q.pop()!.entityId);
    expect(first).toContain(99_999);
    expect(first[0]).toBe(99_999);
  });

  it('never queues an off-screen entity', () => {
    const q = new RefineQueue();
    expect(q.offer(cand(1, 100, 5, { visible: false }))).toBe('rejected');
    expect(q.depth).toBe(0);
  });

  it('overflow evicts by priority, not arrival: survivors are exactly the top set', () => {
    const q = new RefineQueue({ maxDepth: 100 });
    const r = rng(4);
    const scored: [number, number][] = [];
    for (let i = 0; i < 1000; i++) {
      const area = 10 + r() * 10_000, err = 1 + r() * 9;
      scored.push([i, area * (err / 0.5)]);
      q.offer(cand(i, area, err));
    }
    expect(q.depth).toBe(100);
    const top = new Set(scored.sort((a, b) => b[1] - a[1]).slice(0, 100).map((s) => s[0]));
    const kept = new Set<number>();
    for (let c = q.pop(); c; c = q.pop()) kept.add(c.entityId);
    expect(kept).toEqual(top);
    expect(q.stats().evictions).toBe(900);
  });

  it('a newer offer for the same entity replaces the queued one', () => {
    const q = new RefineQueue();
    q.offer(cand(1, 100, 2));
    q.offer(cand(1, 100, 3, { generation: 2 }));
    expect(q.depth).toBe(1);
    expect(q.pop()!.generation).toBe(2);
  });

  it('caps the queue at 4096 by default', () => {
    expect(QUEUE_DEFAULTS.maxDepth).toBe(4096);
    expect(QUEUE_DEFAULTS).toMatchObject({ maxInFlight: 8, perWorkerBytes: 2 * 1024 * 1024, jobTargetMs: 20, scheduleBudgetMs: 0.5 });
  });
});

describe('M6.4 cost and splitting', () => {
  it('cost grows with degree, control points, knot multiplicity and trims', () => {
    const base = { degree: 3, ctrlCount: 8, knotMultiplicity: 1, trimIntervals: 0, errorPx: 2, targetPx: 0.5 };
    const c0 = estimateCostMs(base);
    expect(estimateCostMs({ ...base, degree: 5 })).toBeGreaterThan(c0);
    expect(estimateCostMs({ ...base, ctrlCount: 64 })).toBeGreaterThan(c0);
    expect(estimateCostMs({ ...base, knotMultiplicity: 3 })).toBeGreaterThan(c0);
    expect(estimateCostMs({ ...base, trimIntervals: 4 })).toBeGreaterThan(c0);
  });
  it('splits large curves by parameter range at about 20 ms per piece', () => {
    expect(planPieces(0, 1, 18)).toEqual([[0, 1]]);
    const p = planPieces(0, 1, 95);
    expect(p).toHaveLength(5);
    expect(p[0]![0]).toBe(0);
    expect(p[4]![1]).toBe(1);
    for (let i = 1; i < p.length; i++) expect(p[i]![0]).toBe(p[i - 1]![1]);
  });
});

describe('M6.4 budgets with the pool', () => {
  it('in-flight jobs and per-worker bytes stay inside the caps; p99 job time is within 40 ms', async () => {
    const h = makeHarness({ n: 1500, seed: 31, spread: 120 });
    h.setCamera(pipelineAt({ zoom: 21 }));
    await h.frames(600);
    const s = h.pool.stats();
    expect(s.dispatched).toBeGreaterThan(100);
    expect(s.maxInFlight).toBeLessThanOrEqual(8);
    expect(s.maxWorkerBytes).toBeLessThanOrEqual(QUEUE_DEFAULTS.perWorkerBytes);
    expect(s.p99DurationMs).toBeLessThanOrEqual(40);
  }, 120_000);

  it('saturation: 4 workers stay at least 70 percent busy while work is queued', async () => {
    const h = makeHarness({ n: 2500, seed: 32, spread: 120 });
    h.setCamera(pipelineAt({ zoom: 21 }));
    let frames = 0;
    // run until the queue first drains; utilisation is measured over the window in which work was queued
    while (frames < 3000) {
      await h.frame();
      frames++;
      if (frames > 5 && h.queue.depth === 0) break;
    }
    expect(frames).toBeGreaterThan(30);
    expect(h.pool.utilisation()).toBeGreaterThanOrEqual(0.7);
  }, 120_000);

  it('queues nothing that fails conservative visibility over a scripted camera path', async () => {
    const h = makeHarness({ n: 600, seed: 33, spread: 400 });
    for (let i = 0; i < 120; i++) {
      h.setCamera(pipelineAt({ zoom: 19.5, rotationDeg: 0, bearing: i * 3, center: h.pipeline.transform.forward(-300 + i * 5, 0) }));
      await h.frame();
    }
    await h.frames(60);
    let offscreen = 0;
    for (const j of h.refiner.jobLog) {
      const e = h.entities[j.entityId]!;
      if (!isEntityVisible(e.curve, j.pipeline)) offscreen++;
    }
    expect(h.refiner.jobLog.length).toBeGreaterThan(0);
    expect(offscreen).toBe(0);
  }, 120_000);

  it('main-thread scheduling stays within 0.5 ms per frame during a 10 s pan at 600 px/s', async () => {
    const h = makeHarness({ n: 2000, seed: 34, spread: 300 });
    const sched: number[] = [], frameMs: number[] = [];
    const m = 0.0252 * 4; // metres per CSS px at zoom 19
    for (let i = 0; i < 600; i++) {
      h.setCamera(pipelineAt({ zoom: 19, center: h.pipeline.transform.forward(-150 + (i * FRAME_MS / 1000) * 600 * m, 0) }));
      h.clock.advanceTo(h.clock.now + FRAME_MS);
      await new Promise((r) => setImmediate(r));
      const t0 = performance.now();
      const st = h.refiner.frame();
      frameMs.push(performance.now() - t0);
      sched.push(st.scheduleMs);
    }
    sched.slice(30).sort((a, b) => a - b);
    const s = sched.slice(30).sort((a, b) => a - b);
    expect(s[Math.floor(s.length * 0.99)]!).toBeLessThanOrEqual(0.5);
    expect(Math.max(...frameMs.slice(30))).toBeLessThanOrEqual(16.6);
  }, 120_000);
});
