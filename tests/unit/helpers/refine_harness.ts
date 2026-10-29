import { Refiner, type RefineEntity, type RefinerOptions } from '../../../src/refine/refiner';
import { DrawTable, GenerationTracker } from '../../../src/refine/generation';
import { RefineQueue } from '../../../src/refine/queue';
import { WorkerPool } from '../../../src/workers/pool';
import { MercatorProjectionAdapter, type Camera } from '../../../src/transform/projection';
import type { TransformPipeline } from '../../../src/transform/screen_error';
import { DoubleEvaluator, splineFixture } from './refine';
import { SimWorker, simClock } from './worker_double';
import { anchoredGeoRef, camera, transformOf } from './scene';

export const SITE = { lng: 8.5, lat: 47.4 };
export const FRAME_MS = 1000 / 60;
export const MS_PER_EVAL = 0.0004;
const flush = () => new Promise<void>((r) => setImmediate(r));

export function pipelineAt(over: Partial<Camera> & { rotationDeg?: number } = {}, geo = anchoredGeoRef({ ...SITE, rotationDeg: over.rotationDeg ?? 0 })): TransformPipeline {
  const t = transformOf(geo);
  const c = over.center ?? t.forward(0, 0);
  return { transform: t, projection: MercatorProjectionAdapter, camera: camera({ zoom: 19, ...over, center: c }) };
}

export interface HarnessOptions {
  n?: number;
  workers?: number;
  seed?: number;
  msPerEval?: number;
  queueDepth?: number;
  measure?: RefinerOptions['measure'];
  spread?: number;
}

export function makeHarness(o: HarnessOptions = {}) {
  const clock = simClock();
  const ev = new DoubleEvaluator();
  const sims: SimWorker[] = [];
  const pool = new WorkerPool({
    spawn: () => { const w = new SimWorker(clock, ev, o.msPerEval ?? MS_PER_EVAL); sims.push(w); return w; },
    size: o.workers ?? 4,
    now: () => clock.now,
  });
  const tracker = new GenerationTracker();
  const draw = new DrawTable(tracker);
  const fixture = splineFixture(o.n ?? 500, o.seed ?? 11, o.spread ?? 300);
  const entities: RefineEntity[] = fixture.map((f) => ({
    id: f.id,
    family: 'bezier',
    control: f.control,
    curve: { domain: [0, 1], point: f.curve.point, breakParams: [], strokeWidthPx: 2 },
    cost: { degree: 3, ctrlCount: 4, knotMultiplicity: 1, trimIntervals: 0 },
    displayed: null,
  }));
  const queue = new RefineQueue(o.queueDepth ? { maxDepth: o.queueDepth } : {});
  const refiner = new Refiner({ pool, tracker, draw, queue, entities, now: () => clock.now, measure: o.measure });
  let cam = pipelineAt();
  refiner.setCamera(cam);
  const h = {
    clock, ev, sims, pool, tracker, draw, entities, queue, refiner, fixture,
    get pipeline() { return cam; },
    setCamera(p: TransformPipeline) { cam = p; refiner.setCamera(p); },
    /** One display frame: deliver due worker results, then run the add-on frame. Returns add-on CPU ms. */
    async frame(): Promise<number> {
      clock.advanceTo(clock.now + FRAME_MS);
      await flush();
      const t0 = performance.now();
      refiner.frame();
      return performance.now() - t0;
    },
    async frames(n: number): Promise<void> { for (let i = 0; i < n; i++) await h.frame(); },
    async settle(maxMs = 20_000): Promise<void> {
      const end = clock.now + maxMs;
      while (clock.now < end) {
        await h.frame();
        if (clock.now > refiner.lastCameraChange + 400 && refiner.idle()) return;
      }
    },
  };
  return h;
}
