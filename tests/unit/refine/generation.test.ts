import { describe, expect, it } from 'vitest';
import { DrawTable, GenerationTracker, type JobTag } from '../../../src/refine/generation';
import { rng } from '../helpers/rng';

/** MUTATION: the generation check removed. The harness must go red against this. */
class NoCheckTracker extends GenerationTracker {
  override check(): 'accept' { return 'accept'; }
}

describe('M6.5 generation gate', () => {
  it('rejects a superseded generation at the upload boundary before any GPU write', () => {
    const t = new GenerationTracker();
    const d = new DrawTable(t);
    const g1 = t.next(1), g2 = t.next(1);
    let writes = 0;
    expect(d.upload(g2, { start: 0, count: 10 }, () => writes++)).toBe(true);
    expect(d.upload(g1, { start: 100, count: 10 }, () => writes++)).toBe(false);
    expect(writes).toBe(1);
    expect(t.discarded).toBe(1);
    const frame = d.endFrame();
    expect(frame.get(1)).toMatchObject({ generation: g2.generation, start: 0 });
  });

  it('never presents a stale frame', () => {
    const t = new GenerationTracker();
    const d = new DrawTable(t);
    const g1 = t.next(7), g2 = t.next(7);
    d.upload(g2, { start: 0, count: 1 });
    const before = d.endFrame();
    d.upload(g1, { start: 5, count: 1 });
    const after = d.endFrame();
    expect(after.get(7)).toEqual(before.get(7));
  });

  it('a transformEpoch change invalidates in-flight results and nothing is uploaded', () => {
    const t = new GenerationTracker();
    const d = new DrawTable(t);
    const tag = t.next(3);
    t.bumpEpoch();
    let writes = 0;
    expect(d.upload(tag, { start: 0, count: 1 }, () => writes++)).toBe(false);
    expect(writes).toBe(0);
    expect(t.staleEpoch).toBe(1);
    expect(t.check(t.next(3))).toBe('accept');
  });

  it('bumping the epoch moves every known entity to a new generation', () => {
    const t = new GenerationTracker();
    const a = t.next(1);
    t.bumpEpoch();
    expect(t.current(1)).toBeGreaterThan(a.generation);
  });

  it('applies swaps atomically: draws inside one frame see one generation per entity', () => {
    const t = new GenerationTracker();
    const d = new DrawTable(t);
    const a = t.next(1);
    d.upload(a, { start: 0, count: 4 });
    d.endFrame();
    const b = t.next(1);
    d.upload(b, { start: 8, count: 4 });
    // staged but not swapped: the live frame still draws generation a from one range
    expect(d.live(1)).toMatchObject({ generation: a.generation, start: 0 });
    expect(d.audit().violations).toEqual([]);
    d.endFrame();
    expect(d.live(1)).toMatchObject({ generation: b.generation, start: 8 });
  });
});

function race(Tracker: typeof GenerationTracker, seed: number, requests = 10_000) {
  const r = rng(seed);
  const t = new Tracker();
  const d = new DrawTable(t);
  const entities = 200;
  const inflight: JobTag[] = [];
  let staleShown = 0;
  const newest = new Map<number, number>();
  let epochBumps = 0;
  const shownGen = new Map<number, number>();
  for (let i = 0; i < requests; i++) {
    const id = Math.floor(r() * entities);
    const tag = t.next(id);
    newest.set(id, tag.generation);
    inflight.push(tag);
    // out-of-order completion: finish a random in-flight job now and then
    while (inflight.length > 30 || (inflight.length && r() < 0.5)) {
      const k = Math.floor(r() * inflight.length);
      const done = inflight.splice(k, 1)[0]!;
      const ok = d.upload(done, { start: done.generation, count: 1 });
      const prev = shownGen.get(done.entityId) ?? -1;
      if (ok && done.generation < prev) staleShown++;
      if (ok) shownGen.set(done.entityId, done.generation);
    }
    if (i % 997 === 0) { d.endFrame(); }
  }
  // quiescence: all remaining results arrive in random order
  while (inflight.length) {
    const k = Math.floor(r() * inflight.length);
    const done = inflight.splice(k, 1)[0]!;
    const ok = d.upload(done, { start: done.generation, count: 1 });
    const prev = shownGen.get(done.entityId) ?? -1;
    if (ok && done.generation < prev) staleShown++;
    if (ok) shownGen.set(done.entityId, done.generation);
  }
  d.endFrame();
  let lost = 0;
  for (const [id, g] of newest) if (d.live(id)?.generation !== g) lost++;
  void epochBumps;
  return { staleShown, lost };
}

describe('M6.5 randomised race harness', () => {
  it('10,000 requests with random completion order: 0 stale displayed, 0 lost finals', () => {
    for (const seed of [1, 2, 3]) {
      const r = race(GenerationTracker, seed);
      expect(r.staleShown).toBe(0);
      expect(r.lost).toBe(0);
    }
  });
  it('MUTATION no-generation-check turns the harness red', () => {
    const r = race(NoCheckTracker as typeof GenerationTracker, 1);
    expect(r.staleShown + r.lost).toBeGreaterThan(0);
  });
  it('the forced-race test is red under the same mutation', () => {
    const t = new NoCheckTracker();
    const d = new DrawTable(t);
    const g1 = t.next(1), g2 = t.next(1);
    d.upload(g2, { start: 0, count: 1 });
    expect(d.upload(g1, { start: 5, count: 1 })).toBe(true); // the stale result reaches the GPU
  });
});
