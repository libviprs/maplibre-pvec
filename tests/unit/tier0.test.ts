import { describe, expect, it } from 'vitest';
import { CoverageTracker, FetchGate, Tier0Decoder, type RawEntity } from '../../src/decode/tier0';

const exact = (id: string): RawEntity => ({ entityId: id, kind: 'exact', geometry: { type: 'line', points: [0, 0, 1, 1] }, bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } });
const preview = (id: string): RawEntity => ({ entityId: id, kind: 'preview', geometry: { type: 'polyline', points: [0, 0, 1, 1] }, bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, declaredErrorPx: 1.5 });

function source(entities: RawEntity[]) {
  let i = 0;
  return { next: (max: number) => { if (i >= entities.length) return null; const s = entities.slice(i, i + max); i += s.length; return s; } };
}
const clock = (step = 0) => { let t = 0; return () => (t += step); };

describe('Tier0Decoder (#50 M5.1)', () => {
  it('emits generation-0 draws; previews carry display-fidelity and a declared error, exact ones do not', () => {
    const d = new Tier0Decoder({ maxEntitiesPerBlock: 100, maxSliceMs: 8, now: clock() });
    const draws = d.decodeAll(source([exact('a'), preview('b')]));
    expect(draws.map((x) => x.kind)).toEqual(['exact', 'preview']);
    for (const x of draws) expect(x.generation).toBe(0);
    const p = draws[1]!;
    if (p.kind !== 'preview') throw new Error('type');
    expect(p.conformance).toBe('display-fidelity');
    expect(p.declaredErrorPx).toBe(1.5);
    expect('conformance' in draws[0]!).toBe(false);
    expect('declaredErrorPx' in draws[0]!).toBe(false);
  });

  it('enforces the maximum entities per block', () => {
    const d = new Tier0Decoder({ maxEntitiesPerBlock: 3, maxSliceMs: 8, now: clock() });
    expect(() => d.decodeAll(source(Array.from({ length: 10 }, (_, i) => exact(`e${i}`))))).toThrow(/maxEntitiesPerBlock/);
  });

  it('slices: each slice stays inside the time budget and the work resumes', () => {
    const d = new Tier0Decoder({ maxEntitiesPerBlock: 1000, maxSliceMs: 8, now: clock(1) });
    const src = source(Array.from({ length: 100 }, (_, i) => exact(`e${i}`)));
    const slices: number[] = [];
    for (let s = d.decodeSlice(src); s; s = d.decodeSlice(src)) slices.push(s.draws.length);
    expect(slices.length).toBeGreaterThan(1);
    expect(slices.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('rejects a preview without a declared error', () => {
    const d = new Tier0Decoder({ maxEntitiesPerBlock: 10, maxSliceMs: 8, now: clock() });
    const bad = { ...preview('x'), declaredErrorPx: undefined } as unknown as RawEntity;
    expect(() => d.decodeAll(source([bad]))).toThrow(/declaredErrorPx/);
  });
});

describe('coverage by id set (#50 M5.1)', () => {
  it('fires tier0complete exactly when expected minus submitted is empty', () => {
    let fired = 0;
    const t = new CoverageTracker(new Set(['a', 'b', 'c']), () => { fired++; });
    t.submit('a'); t.submit('b');
    expect([...t.missing()]).toEqual(['c']);
    expect(fired).toBe(0);
    t.submit('c'); t.submit('c');
    expect(fired).toBe(1);
    expect(t.complete).toBe(true);
  });

  it('a planted missing entity keeps it red', () => {
    let fired = 0;
    const t = new CoverageTracker(new Set(['a', 'b']), () => { fired++; });
    t.submit('a');
    expect(t.complete).toBe(false);
    expect(fired).toBe(0);
  });

  it('the fetch gate refuses deferred ranges until tier0complete', () => {
    const t = new CoverageTracker(new Set(['a']), () => {});
    const gate = new FetchGate(t);
    const log: Array<[number, number]> = [];
    const request = (tier: 'tier0' | 'deferred', r: [number, number]) => { if (gate.mayRequest(tier)) log.push(r); };
    request('deferred', [100, 200]);
    request('tier0', [0, 50]);
    t.submit('a');
    request('deferred', [100, 200]);
    expect(log).toEqual([[0, 50], [100, 200]]);
  });
});
