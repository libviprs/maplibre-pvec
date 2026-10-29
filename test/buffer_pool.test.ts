import { describe, expect, it } from 'vitest';
import { BufferPool } from '../src/render/buffer_pool';
import { FakeGl } from './helpers/fake_gl';

const bytes = (n: number, seed = 1) => { const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = (i * 31 + seed) & 255; return u; };
const clock = () => { let t = 0; return { now: () => t, tick: (d: number) => { t += d; } }; };
const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

describe('buffer pool (#50 M5.5)', () => {
  it('10 000 add/remove cycles on 50 000 entities return to baseline with no GL error', () => {
    const gl = new FakeGl();
    const pool = new BufferPool(gl as never, { pageBytes: 4 * 1024 * 1024, uploadBudgetBytes: Infinity, uploadBudgetMs: Infinity, now: () => 0 });
    for (let i = 0; i < 50_000; i++) pool.add(`e${i}`, bytes(40, i));
    pool.flush(); pool.completeFrame(1);
    const base = pool.accounting();
    let frame = 2;
    for (let c = 0; c < 10_000; c++) {
      const k = `e${(c * 7919) % 50_000}`;
      pool.remove(k);
      pool.add(k, bytes(40, c));
      if (c % 100 === 0) { pool.flush(); pool.completeFrame(frame++); }
    }
    pool.flush(); pool.completeFrame(frame);
    const end = pool.accounting();
    expect(Math.abs(end.liveBuffers - base.liveBuffers) / base.liveBuffers).toBeLessThanOrEqual(0.02);
    expect(Math.abs(end.arenaBytes - base.arenaBytes) / base.arenaBytes).toBeLessThanOrEqual(0.02);
    expect(gl.getError()).toBe(0);
  });

  it('dispose deletes every buffer and zeroes accounting', () => {
    const gl = new FakeGl();
    const pool = new BufferPool(gl as never, { now: () => 0 });
    for (let i = 0; i < 100; i++) pool.add(`e${i}`, bytes(40));
    pool.flush();
    expect(gl.buffers.size).toBeGreaterThan(0);
    pool.dispose();
    expect(gl.buffers.size).toBe(0);
    expect(pool.accounting()).toMatchObject({ arenaBytes: 0, liveBuffers: 0, usedBytes: 0 });
  });

  it('a 64 MiB burst is spread across frames, nothing dropped, bytes identical to a single shot', () => {
    const total = 64 * 1024 * 1024;
    const src = bytes(total, 5);
    const gl = new FakeGl();
    const c = clock();
    const pool = new BufferPool(gl as never, { pageBytes: 4 * 1024 * 1024, uploadBudgetBytes: 4 * 1024 * 1024, uploadBudgetMs: 2, now: c.now });
    const per = 1024 * 1024;
    for (let i = 0; i < total / per; i++) pool.add(`b${i}`, src.subarray(i * per, (i + 1) * per));
    let frames = 0, inBudget = 0, f = 1;
    while (pool.accounting().queuedBytes > 0) {
      const r = pool.flush();
      frames++; if (r.uploadedBytes <= 4 * 1024 * 1024) inBudget++;
      pool.completeFrame(f++);
      expect(frames).toBeLessThan(1000);
    }
    expect(inBudget / frames).toBeGreaterThanOrEqual(0.9);
    expect(frames).toBeGreaterThan(1);
    for (let i = 0; i < total / per; i++) {
      const r = pool.range(`b${i}`)!;
      expect(same(gl.buffers.get(r.buffer)!.subarray(r.offset, r.offset + per), src.subarray(i * per, (i + 1) * per))).toBe(true);
    }
  });

  it('time budget stops a flush but always makes progress', () => {
    const gl = new FakeGl();
    const c = clock();
    const pool = new BufferPool(gl as never, { uploadBudgetBytes: Infinity, uploadBudgetMs: 2, now: c.now });
    const orig = gl.bufferSubData.bind(gl);
    gl.bufferSubData = (t: number, o: number, d: Uint8Array) => { c.tick(1.5); orig(t, o, d); };
    for (let i = 0; i < 10; i++) pool.add(`e${i}`, bytes(64));
    const r = pool.flush();
    expect(r.uploadedBytes).toBeGreaterThan(0);
    expect(pool.accounting().queuedBytes).toBeGreaterThan(0);
  });

  it('removal is deferred: a freed range is not reused until the referencing frame completes', () => {
    const gl = new FakeGl();
    const pool = new BufferPool(gl as never, { pageBytes: 1024, now: () => 0 });
    pool.add('a', bytes(512)); pool.add('b', bytes(512)); pool.flush();
    pool.beginFrame(7);
    const ra = pool.range('a')!;
    pool.remove('a');
    pool.add('c', bytes(512));
    const rc = pool.range('c')!;
    expect(rc.offset === ra.offset && rc.buffer === ra.buffer).toBe(false);
    pool.completeFrame(7);
    pool.add('d', bytes(512));
    expect(pool.range('d')!.offset).toBe(ra.offset);
  });

  it('forced race: removing a block while its job is in flight neither uploads nor throws', () => {
    const gl = new FakeGl();
    const pool = new BufferPool(gl as never, { now: () => 0 });
    const epoch = pool.begin('blk');
    pool.remove('blk');
    let ok = true;
    expect(() => { ok = pool.commit('blk', epoch, bytes(128)); }).not.toThrow();
    expect(ok).toBe(false);
    expect(pool.range('blk')).toBeUndefined();
    const e2 = pool.begin('blk');
    expect(pool.commit('blk', e2, bytes(128))).toBe(true);
    expect(pool.range('blk')).toBeDefined();
  });

  it('update keeps contents correct when the size changes', () => {
    const gl = new FakeGl();
    const pool = new BufferPool(gl as never, { now: () => 0 });
    pool.add('a', bytes(80, 1)); pool.update('a', bytes(160, 2)); pool.flush();
    const r = pool.range('a')!;
    expect(r.length).toBe(160);
    expect(same(gl.buffers.get(r.buffer)!.subarray(r.offset, r.offset + 160), bytes(160, 2))).toBe(true);
  });

  it('compacts above 35 percent fragmentation without losing data', () => {
    const gl = new FakeGl();
    const pool = new BufferPool(gl as never, { pageBytes: 4096, now: () => 0 });
    for (let i = 0; i < 64; i++) pool.add(`e${i}`, bytes(64, i));
    pool.flush(); pool.completeFrame(1);
    for (let i = 0; i < 64; i += 2) pool.remove(`e${i}`);
    pool.flush(); pool.completeFrame(2);
    expect(pool.accounting().fragmentation).toBeGreaterThan(0.35);
    pool.maybeCompact(); pool.flush(); pool.completeFrame(3);
    expect(pool.accounting().fragmentation).toBeLessThanOrEqual(0.35);
    for (let i = 1; i < 64; i += 2) {
      const r = pool.range(`e${i}`)!;
      expect(same(gl.buffers.get(r.buffer)!.subarray(r.offset, r.offset + 64), bytes(64, i))).toBe(true);
    }
  });

  it('rebuilds from retained bytes after a context loss', () => {
    const gl = new FakeGl();
    const pool = new BufferPool(gl as never, { now: () => 0 });
    pool.add('a', bytes(96, 3)); pool.flush();
    pool.dropGlHandles();
    expect(pool.accounting().liveBuffers).toBe(0);
    const gl2 = new FakeGl();
    pool.rebind(gl2 as never); pool.flush();
    const r = pool.range('a')!;
    expect(same(gl2.buffers.get(r.buffer)!.subarray(r.offset, r.offset + 96), bytes(96, 3))).toBe(true);
  });
});
