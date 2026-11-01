import { describe, expect, it } from 'vitest';
import { quietest } from './helpers/load';

describe('#146 quietest: the smallest time per step across runs', () => {
  it('a quiet host passes on the first run and is not run again', async () => {
    let runs = 0;
    const r = await quietest(() => (runs++, [1, 2, 3]), (p) => Math.max(...p) <= 16.6);
    expect([r.runs, runs]).toEqual([1, 1]);
  });

  it('a preemption that lands on a different step each run drops out', async () => {
    const spikes = [[30, 1, 1, 1], [1, 30, 1, 1]];
    let n = 0;
    const r = await quietest(() => spikes[n++]!, (p) => Math.max(...p) <= 16.6);
    expect(r.profile).toEqual([1, 1, 1, 1]);
    expect(r.runs).toBe(2);
  });

  it('work that costs more than the budget in every run still fails, after at most five runs', async () => {
    let runs = 0;
    const r = await quietest(() => (runs++, [2, 20 + runs, 2]), (p) => Math.max(...p) <= 16.6);
    expect(r.runs).toBe(5);
    expect(Math.max(...r.profile)).toBeGreaterThan(16.6);
  });
});
