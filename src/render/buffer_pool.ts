import { DEFAULTS } from '../config/defaults';

type Gl = Pick<WebGL2RenderingContext, 'createBuffer' | 'deleteBuffer' | 'bindBuffer' | 'bufferData' | 'bufferSubData' | 'ARRAY_BUFFER' | 'STATIC_DRAW'>;

export interface PoolOptions {
  pageBytes?: number;
  uploadBudgetBytes?: number;
  uploadBudgetMs?: number;
  compactAbove?: number;
  now?: () => number;
}

export interface BufferAccounting {
  /** Bytes of GL storage held by live arena pages. */
  arenaBytes: number;
  /** Live GL buffers (one per page). */
  liveBuffers: number;
  usedBytes: number;
  /** 0 = every page has at most one free block, towards 1 = free space shattered. */
  fragmentation: number;
  queuedBytes: number;
}

interface Block { off: number; len: number }
interface Page { size: number; glBuffer: WebGLBuffer | null; free: Block[]; used: number; pending: number }
interface Entry { page: Page; offset: number; length: number; bytes: Uint8Array; uploaded: number; queued: boolean }

/**
 * Sub-allocating arenas of fixed-size pages with a free list. Each entry keeps its source
 * bytes so compaction and context-loss rebuild never need a decode round trip. Frees are
 * deferred until the frame that may have referenced the range has completed.
 */
export class BufferPool {
  private gl: Gl;
  private readonly pageBytes: number;
  private readonly budgetBytes: number;
  private readonly budgetMs: number;
  private readonly compactAbove: number;
  private readonly now: () => number;
  private pages: Page[] = [];
  private entries = new Map<string, Entry>();
  private queue: string[] = [];
  private epochs = new Map<string, number>();
  private pendingFree: Array<{ page: Page; block: Block; frame: number }> = [];
  private frame = 0;

  constructor(gl: Gl, o: PoolOptions = {}) {
    this.gl = gl;
    this.pageBytes = o.pageBytes ?? DEFAULTS.arenaPageBytes;
    this.budgetBytes = o.uploadBudgetBytes ?? DEFAULTS.uploadBudgetBytes;
    this.budgetMs = o.uploadBudgetMs ?? DEFAULTS.uploadBudgetMs;
    this.compactAbove = o.compactAbove ?? DEFAULTS.compactAboveFragmentation;
    this.now = o.now ?? (() => performance.now());
  }

  add(key: string, bytes: Uint8Array): void {
    if (this.entries.has(key)) { this.update(key, bytes); return; }
    this.place(key, bytes);
  }

  update(key: string, bytes: Uint8Array): void {
    const e = this.entries.get(key);
    if (!e) { this.place(key, bytes); return; }
    if (e.length === align(bytes.byteLength)) {
      e.bytes = bytes; e.uploaded = 0; this.enqueue(key, e);
      return;
    }
    this.release(key);
    this.place(key, bytes);
  }

  remove(key: string): void {
    this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
    this.release(key);
  }

  /** Start an asynchronous job for `key`; `commit` with the returned epoch later. */
  begin(key: string): number { return this.epochs.get(key) ?? 0; }

  /** Land a job's result. Returns false, doing nothing, when the key was removed since `begin`. */
  commit(key: string, epoch: number, bytes: Uint8Array): boolean {
    if ((this.epochs.get(key) ?? 0) !== epoch) return false;
    this.add(key, bytes);
    return true;
  }

  range(key: string): { buffer: WebGLBuffer; offset: number; length: number } | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (!e.page.glBuffer) this.ensure(e.page);
    return { buffer: e.page.glBuffer!, offset: e.offset, length: e.length };
  }

  beginFrame(frame: number): void { this.frame = frame; }

  completeFrame(frame: number): void {
    const keep: typeof this.pendingFree = [];
    for (const p of this.pendingFree) {
      if (p.frame > frame) { keep.push(p); continue; }
      p.page.pending -= p.block.len;
      this.freeBlock(p.page, p.block);
    }
    this.pendingFree = keep;
    this.pages = this.pages.filter((pg) => {
      if (pg.used > 0 || pg.pending > 0) return true;
      if (pg.glBuffer) this.gl.deleteBuffer(pg.glBuffer);
      return false;
    });
  }

  /** Upload queued data inside the per-frame byte and time budget. Always makes progress. */
  flush(): { uploadedBytes: number } {
    const start = this.now();
    let sent = 0;
    while (this.queue.length) {
      const key = this.queue[0]!;
      const e = this.entries.get(key);
      if (!e || e.uploaded >= e.bytes.byteLength) { if (e) e.queued = false; this.queue.shift(); continue; }
      if (sent > 0 && (sent >= this.budgetBytes || this.now() - start >= this.budgetMs)) break;
      const n = Math.min(e.bytes.byteLength - e.uploaded, Math.max(this.budgetBytes - sent, 1));
      this.ensure(e.page);
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, e.page.glBuffer);
      this.gl.bufferSubData(this.gl.ARRAY_BUFFER, e.offset + e.uploaded, e.bytes.subarray(e.uploaded, e.uploaded + n));
      e.uploaded += n; sent += n;
    }
    return { uploadedBytes: sent };
  }

  /** Repack fragmented pages that have no deferred frees outstanding. */
  maybeCompact(): boolean {
    if (this.fragmentation() <= this.compactAbove) return false;
    for (const pg of this.pages) {
      if (pg.free.length <= 1 || pg.pending > 0) continue;
      const here = [...this.entries.entries()].filter(([, e]) => e.page === pg).sort((a, b) => a[1].offset - b[1].offset);
      let off = 0;
      for (const [k, e] of here) {
        if (e.offset !== off) { e.offset = off; e.uploaded = 0; this.enqueue(k, e); }
        off += e.length;
      }
      pg.free = off < pg.size ? [{ off, len: pg.size - off }] : [];
    }
    return true;
  }

  accounting(): BufferAccounting {
    let queued = 0;
    for (const k of this.queue) { const e = this.entries.get(k); if (e) queued += e.bytes.byteLength - e.uploaded; }
    return {
      arenaBytes: this.pages.reduce((a, p) => a + (p.glBuffer ? p.size : 0), 0),
      liveBuffers: this.pages.filter((p) => p.glBuffer).length,
      usedBytes: this.pages.reduce((a, p) => a + p.used, 0),
      fragmentation: this.fragmentation(),
      queuedBytes: queued,
    };
  }

  /** The context is gone: forget every GL handle, keep the data, requeue everything. */
  dropGlHandles(): void {
    for (const pg of this.pages) pg.glBuffer = null;
    this.queue = [];
    for (const [k, e] of this.entries) { e.uploaded = 0; e.queued = false; this.enqueue(k, e); }
  }

  rebind(gl: Gl): void { this.gl = gl; }

  dispose(): void {
    for (const pg of this.pages) if (pg.glBuffer) this.gl.deleteBuffer(pg.glBuffer);
    this.pages = []; this.entries.clear(); this.queue = []; this.pendingFree = []; this.epochs.clear();
  }

  private fragmentation(): number {
    let total = 0, largest = 0;
    for (const pg of this.pages) {
      let big = 0;
      for (const b of pg.free) { total += b.len; big = Math.max(big, b.len); }
      largest += big;
    }
    return total === 0 ? 0 : 1 - largest / total;
  }

  private enqueue(key: string, e: Entry): void {
    if (!e.queued) { e.queued = true; this.queue.push(key); }
  }

  private ensure(pg: Page): void {
    if (pg.glBuffer) return;
    pg.glBuffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, pg.glBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, pg.size, this.gl.STATIC_DRAW);
  }

  private place(key: string, bytes: Uint8Array): void {
    const len = align(bytes.byteLength);
    let target: Page | undefined, at = -1;
    for (const pg of this.pages) {
      const i = pg.free.findIndex((b) => b.len >= len);
      if (i >= 0) { target = pg; at = i; break; }
    }
    if (!target) {
      target = { size: Math.max(this.pageBytes, len), glBuffer: null, free: [{ off: 0, len: Math.max(this.pageBytes, len) }], used: 0, pending: 0 };
      this.pages.push(target);
      at = 0;
    }
    const b = target.free[at]!;
    const offset = b.off;
    if (b.len === len) target.free.splice(at, 1); else { b.off += len; b.len -= len; }
    target.used += len;
    this.ensure(target);
    const e: Entry = { page: target, offset, length: len, bytes, uploaded: 0, queued: false };
    this.entries.set(key, e);
    this.enqueue(key, e);
  }

  private release(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    e.page.used -= e.length;
    e.page.pending += e.length;
    this.pendingFree.push({ page: e.page, block: { off: e.offset, len: e.length }, frame: this.frame });
  }

  private freeBlock(pg: Page, blk: Block): void {
    const f = pg.free;
    let i = 0;
    while (i < f.length && f[i]!.off < blk.off) i++;
    f.splice(i, 0, { off: blk.off, len: blk.len });
    if (i + 1 < f.length && f[i]!.off + f[i]!.len === f[i + 1]!.off) { f[i]!.len += f[i + 1]!.len; f.splice(i + 1, 1); }
    if (i > 0 && f[i - 1]!.off + f[i - 1]!.len === f[i]!.off) { f[i - 1]!.len += f[i]!.len; f.splice(i, 1); }
  }
}

function align(n: number): number { return (n + 3) & ~3; }
