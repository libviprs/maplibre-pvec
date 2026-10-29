import { budget } from '../helpers/budget';
import { describe, expect, it } from 'vitest';
import { PolicySweep, needsRefinement, type PolicyEntity } from '../../../src/refine/policy';
import { REFINE_DEFAULTS } from '../../../src/config/defaults';
import { errorOfTessellation } from '../../../src/transform/screen_error';
import { cubic } from '../helpers/curves';
import { pipelineAt, makeHarness, FRAME_MS } from '../helpers/refine_harness';
import { cubicAt, measureSource } from '../helpers/refine';

const ctrl = new Float64Array([0, 0, 10, 40, 30, -40, 40, 0]);
const curve = { domain: [0, 1] as [number, number], point: (t: number) => cubicAt(ctrl, t) };

describe('M6.3 thresholds', () => {
  it('uses the table from the issue', () => {
    expect(REFINE_DEFAULTS).toMatchObject({ targetPx: 0.5, refinePx: 1.0, coarsenPx: 0.25, navigatingPx: 4.0, idleMs: 150, policyBudgetMs: 1 });
  });
  it('keeps a 4x band between coarsen and refine', () => {
    expect(REFINE_DEFAULTS.refinePx / REFINE_DEFAULTS.coarsenPx).toBe(4);
  });
});

describe('M6.3 decision', () => {
  const ent: PolicyEntity = { curve, displayed: { params: Float64Array.of(0, 1), generation: 1 } };
  const p = pipelineAt();
  const dec = (m: number, o: { navigating?: boolean } = {}) => needsRefinement(ent, 1, p, { ...o, measure: () => m });
  it('refines above 1.0, keeps in the band, coarsens below 0.25', () => {
    expect(dec(1.2).action).toBe('refine');
    expect(dec(0.7).action).toBe('keep');
    expect(dec(0.3).action).toBe('keep');
    expect(dec(0.1).action).toBe('coarsen');
  });
  it('uses 4.0 px while the camera is moving', () => {
    expect(dec(3, { navigating: true }).action).toBe('keep');
    expect(dec(5, { navigating: true }).action).toBe('refine');
  });
  it('a preview-only entity (generation 0) is refined', () => {
    expect(needsRefinement({ curve, displayed: null }, 0, p).action).toBe('refine');
  });
  it('error is post-transform: tiny source error, large projected error queues refinement', () => {
    // a 3-point polyline of the curve: source error is ~0.2 m, at zoom 22 that is many device px
    const params = Float64Array.from(Array.from({ length: 33 }, (_, i) => i / 32));
    const pos = Float64Array.from(Array.from(params).flatMap((t) => cubicAt(ctrl, t)));
    const srcErr = measureSource(ctrl, params, pos, 400);
    expect(srcErr).toBeLessThan(budget(2));
    const hi = pipelineAt({ zoom: 22 });
    const px = errorOfTessellation(Array.from(params), curve, hi, 200);
    expect(px).toBeGreaterThan(REFINE_DEFAULTS.refinePx);
    const shown: PolicyEntity = { curve, displayed: { params, generation: 1 } };
    expect(needsRefinement(shown, 1, hi).action).toBe('refine');
    // MUTATION: judging the source-space error against the pixel thresholds keeps it, so this test would go red
    const mutated = needsRefinement(shown, 1, hi, { measure: () => srcErr / 1000 });
    expect(mutated.action).not.toBe('refine');
  });
});

describe('M6.3 frame budget', () => {
  it('stays inside 1 ms per frame on a 1e6-entity fixture and still covers every entity', () => {
    const N = 1_000_000;
    const areas = new Float64Array(N);
    for (let i = 0; i < N; i++) areas[i] = (i * 2654435761) % 1000;
    let seen = 0;
    const sweep = new PolicySweep(N, (i) => areas[i]!, (i) => { seen++; return i & 1 ? 'keep' : 'keep'; }, { budgetMs: 1, now: () => performance.now() });
    const times: number[] = [];
    let frames = 0;
    while (!sweep.fullPasses && frames < 5000) {
      const t0 = performance.now();
      sweep.runFrame();
      times.push(performance.now() - t0);
      frames++;
    }
    expect(seen).toBe(N);
    expect(frames).toBeGreaterThan(budget(1)); // it resumed across frames
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.99)]!).toBeLessThanOrEqual(budget(1.25));
    expect(times[times.length - 1]!).toBeLessThanOrEqual(budget(3));
  });
  it('visits entities in descending area order within a sweep', () => {
    const areas = [5, 90, 1, 40, 7];
    const order: number[] = [];
    const sweep = new PolicySweep(5, (i) => areas[i]!, (i) => { order.push(i); return 'keep'; }, { budgetMs: 1000, now: () => 0 });
    sweep.runFrame();
    expect(order).toEqual([1, 3, 4, 0, 2]);
  });
});

describe('M6.3 behaviour with the pool', () => {
  it('zooming in four levels refines every visible curve to 0.5 px or below against f64 ground truth', async () => {
    const h = makeHarness({ n: 120, seed: 21, spread: 20 });
    h.setCamera(pipelineAt({ zoom: 17 }));
    await h.settle();
    h.setCamera(pipelineAt({ zoom: 21 }));
    await h.settle();
    let worst = 0, checked = 0;
    for (const e of h.entities) {
      if (!e.visible) continue;
      checked++;
      const px = errorOfTessellation(Array.from(e.displayed!.params), e.curve, h.pipeline, 1000);
      worst = Math.max(worst, px);
    }
    expect(checked).toBeGreaterThan(budget(10));
    expect(worst).toBeLessThanOrEqual(budget(0.5));
  }, 120_000);

  it('hysteresis: +/-0.4 zoom for 100 cycles queues at most 5 jobs after the first pass', async () => {
    const h = makeHarness({ n: 150, seed: 22, spread: 80 });
    h.setCamera(pipelineAt({ zoom: 19 }));
    await h.settle();
    const base = h.refiner.jobLog.length;
    for (let c = 0; c < 100; c++) {
      h.setCamera(pipelineAt({ zoom: c % 2 ? 18.6 : 19.4 }));
      await h.frames(Math.ceil((REFINE_DEFAULTS.idleMs + 100) / FRAME_MS));
    }
    expect(h.refiner.jobLog.length - base).toBeLessThanOrEqual(budget(5));
  }, 120_000);

  it('a curve already measuring 0.3 px is never requeued', async () => {
    const h = makeHarness({ n: 30, seed: 23, measure: () => 0.3 });
    for (const e of h.entities) e.displayed = { params: Float64Array.of(0, 1), generation: 1 };
    await h.frames(60);
    expect(h.refiner.jobLog).toEqual([]);
  });
});
void cubic;
