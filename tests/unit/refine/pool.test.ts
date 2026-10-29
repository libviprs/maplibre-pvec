import { budget } from '../helpers/budget';
import { describe, expect, it } from 'vitest';
import { BufferRecycler, WorkerPool, defaultWorkerCount } from '../../../src/workers/pool';
import { EVAL_BATCH } from '../../../src/workers/evaluator';
import { DoubleEvaluator, splineFixture } from '../helpers/refine';
import { ChannelWorker, SimWorker, simClock } from '../helpers/worker_double';

const job = (control: Float64Array, chord = 0.01, entityId = 1) => ({
  family: 'bezier' as const, control, t0: 0, t1: 1, chordUnits: chord, tag: { entityId, generation: 1, transformEpoch: 0 },
});

describe('M6.2 sizing', () => {
  it('defaults to clamp(hardwareConcurrency - 1, 1, 4)', () => {
    expect([1, 2, 3, 5, 8, 64].map(defaultWorkerCount)).toEqual([1, 1, 2, 4, 4, 4]);
  });
});

describe('M6.2 zero copy', () => {
  it('detaches the payload in the sender and again in the worker, in both directions', async () => {
    const ev = new DoubleEvaluator();
    const pool = new WorkerPool({ spawn: () => new ChannelWorker(ev), size: 2, now: () => performance.now() });
    const e = splineFixture(1, 1)[0]!;
    const control = e.control;
    const p = pool.tryRun(job(control))!;
    expect(control.buffer.byteLength).toBe(0); // detached in the sender after posting
    const res = await p;
    expect(res.status).toBe('done');
    if (res.status !== 'done') return;
    expect(res.positions.length).toBeGreaterThan(budget(4));
    const s = pool.stats();
    expect(s.copiesDetected).toBe(0);
    expect(s.detachChecks).toBeGreaterThanOrEqual(2); // control out, results in (worker side asserts its own)
    pool.terminate();
  });

  it('the recycler hands transferred buffers back to the sender', async () => {
    const r = new BufferRecycler();
    const a = r.acquire(64);
    r.release(a);
    expect(r.acquire(64)).toBe(a);
    expect(r.acquire(64)).not.toBe(a);
    const ev = new DoubleEvaluator();
    const pool = new WorkerPool({ spawn: () => new ChannelWorker(ev), size: 1, now: () => performance.now() });
    const e = splineFixture(1, 2)[0]!;
    const res = await pool.tryRun(job(e.control))!;
    expect(res.status).toBe('done');
    // the control buffer came back from the worker and is reusable
    expect(pool.recycler.pooledBuffers).toBeGreaterThanOrEqual(1);
    pool.terminate();
  });
});

describe('M6.2 shared memory is optional and identical', () => {
  it('only when crossOriginIsolated and enabled; output is byte-identical to the transferable path', async () => {
    const e = splineFixture(1, 3)[0]!;
    const run = async (shared: boolean, isolated: boolean) => {
      const ev = new DoubleEvaluator();
      const pool = new WorkerPool({ spawn: () => new ChannelWorker(ev, { shared: shared && isolated }), size: 1, now: () => 0, sharedMemory: shared, isolated });
      const res = await pool.tryRun(job(Float64Array.from(e.control), 0.002))!;
      pool.terminate();
      if (res.status !== 'done') throw new Error('not done');
      return { res, usedShared: pool.stats().sharedPath };
    };
    const plain = await run(false, false);
    const notIsolated = await run(true, false);
    const shared = await run(true, true);
    expect(plain.usedShared).toBe(false);
    expect(notIsolated.usedShared).toBe(false); // option set but not isolated: falls back, never requires it
    expect(shared.usedShared).toBe(true);
    expect(Buffer.from(shared.res.positions.buffer, shared.res.positions.byteOffset, shared.res.positions.byteLength))
      .toEqual(Buffer.from(plain.res.positions.buffer, plain.res.positions.byteOffset, plain.res.positions.byteLength));
    expect(shared.res.positions.buffer instanceof SharedArrayBuffer).toBe(true);
  });
});

describe('M6.2 cancellation', () => {
  it('stops within one evaluation batch of the cancel message', async () => {
    const ev = new DoubleEvaluator();
    const pool = new WorkerPool({ spawn: () => new ChannelWorker(ev), size: 1, now: () => performance.now() });
    const e = splineFixture(1, 4)[0]!;
    const ac = new AbortController();
    const p = pool.tryRun(job(e.control, 1e-9), ac.signal)!;
    // let it get going
    await new Promise((r) => setTimeout(r, 30));
    const callsAtCancel = ev.calls;
    ac.abort();
    const res = await p;
    expect(res.status).toBe('cancelled');
    expect(ev.calls - callsAtCancel).toBeLessThanOrEqual(budget(2));
    expect(ev.maxBatch).toBeLessThanOrEqual(EVAL_BATCH);
    pool.terminate();
  }, 20_000);

  it('wasted work after cancellation is at most 5 percent of total evaluation time', async () => {
    const clock = simClock();
    const ev = new DoubleEvaluator();
    const sims: SimWorker[] = [];
    const pool = new WorkerPool({ spawn: () => { const w = new SimWorker(clock, ev, 0.0004); sims.push(w); return w; }, size: 2, now: () => clock.now });
    const els = splineFixture(60, 6, 30);
    const acs = els.map(() => new AbortController());
    const proms = els.map((e, i) => {
      for (;;) {
        const p = pool.tryRun(job(Float64Array.from(e.control), 1e-6, e.id), acs[i]!.signal);
        if (p) return p;
        clock.advanceTo(clock.now + 1);
      }
    });
    // cancel every third job a little after it starts
    clock.advanceTo(clock.now + 5);
    els.forEach((_, i) => { if (i % 3 === 0) acs[i]!.abort(); });
    clock.advanceTo(clock.now + 1e6);
    const out = await Promise.all(proms);
    expect(out.some((r) => r.status === 'cancelled')).toBe(true);
    const wasted = sims.reduce((a, s) => a + s.wastedMs, 0);
    const total = sims.reduce((a, s) => a + s.busyMs, 0);
    expect(wasted / total).toBeLessThanOrEqual(budget(0.05));
  }, 60_000);
});

describe('M6.2 header-free', () => {
  it('no code path needs crossOriginIsolated', async () => {
    const ev = new DoubleEvaluator();
    const pool = new WorkerPool({ spawn: () => new ChannelWorker(ev), size: 1, now: () => 0, isolated: false });
    const e = splineFixture(1, 9)[0]!;
    const r = await pool.tryRun(job(e.control))!;
    expect(r.status).toBe('done');
    expect(pool.stats().sharedPath).toBe(false);
    pool.terminate();
  });
});
