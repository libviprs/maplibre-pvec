import { MessageChannel } from 'node:worker_threads';
import { type CurveEvaluator, refineSteps } from '../../../src/workers/evaluator';
import { WorkerRuntime, type WorkerLike, type WorkerIn, type WorkerOut } from '../../../src/workers/runtime';

/**
 * A worker double over a real MessageChannel: postMessage with a transfer list detaches buffers
 * exactly as a browser Worker does, and the runtime really runs between macrotask yields.
 */
export class ChannelWorker implements WorkerLike {
  onmessage: ((e: { data: WorkerOut }) => void) | null = null;
  readonly runtime: WorkerRuntime;
  private readonly toWorker: MessagePort;
  private readonly fromWorker: MessagePort;
  constructor(evaluator: CurveEvaluator, o: { shared?: boolean } = {}) {
    const ch = new MessageChannel();
    this.toWorker = ch.port1 as unknown as MessagePort;
    this.fromWorker = ch.port2 as unknown as MessagePort;
    this.runtime = new WorkerRuntime(
      evaluator,
      (msg, transfer) => (this.fromWorker as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(msg, transfer),
      { yield: () => new Promise((r) => setImmediate(r)), shared: o.shared },
    );
    (this.fromWorker as unknown as { on(e: string, f: (d: WorkerIn) => void): void }).on('message', (d) => this.runtime.onMessage(d));
    (this.toWorker as unknown as { on(e: string, f: (d: WorkerOut) => void): void }).on('message', (d) => this.onmessage?.({ data: d }));
    (this.toWorker as unknown as { unref(): void }).unref();
    (this.fromWorker as unknown as { unref(): void }).unref();
  }
  postMessage(msg: WorkerIn, transfer: Transferable[] = []): void {
    (this.toWorker as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(msg, transfer);
  }
  terminate(): void {
    (this.toWorker as unknown as { close(): void }).close();
    (this.fromWorker as unknown as { close(): void }).close();
  }
}

export interface SimClock {
  now: number;
  /** Run every due event up to and including `t`, advancing `now` to `t`. */
  advanceTo(t: number): void;
  at(t: number, fn: () => void): void;
}

export function simClock(): SimClock {
  const events: { t: number; fn: () => void; seq: number }[] = [];
  let seq = 0;
  const c: SimClock = {
    now: 0,
    at(t, fn) { events.push({ t, fn, seq: seq++ }); },
    advanceTo(t) {
      for (;;) {
        events.sort((a, b) => a.t - b.t || a.seq - b.seq);
        const e = events[0];
        if (!e || e.t > t) break;
        events.shift();
        c.now = Math.max(c.now, e.t);
        e.fn();
      }
      c.now = Math.max(c.now, t);
    },
  };
  return c;
}

/**
 * Virtual-time worker: it runs the real batching loop (refineSteps) and charges `msPerEval` of
 * virtual time per evaluation. Jobs run one at a time in arrival order. A cancel takes effect at
 * the next batch boundary, and the time between the cancel and that boundary is recorded as waste.
 */
export class SimWorker implements WorkerLike {
  onmessage: ((e: { data: WorkerOut }) => void) | null = null;
  busyMs = 0;
  wastedMs = 0;
  private cancelled = new Set<number>();
  private cancelStamp = new Map<number, number>();
  private pending: Extract<WorkerIn, { type: 'job' }>[] = [];
  private running = false;
  constructor(private readonly clock: SimClock, private readonly ev: CurveEvaluator, private readonly msPerEval = 0.0004) {}
  postMessage(msg: WorkerIn, transfer: Transferable[] = []): void {
    if (msg.type === 'init') return;
    if (msg.type === 'cancel') {
      this.cancelled.add(msg.jobId);
      this.cancelStamp.set(msg.jobId, this.clock.now);
      return;
    }
    for (const t of transfer) structuredClone(t, { transfer: [t] }); // detach like a real transfer
    this.pending.push(msg);
    if (!this.running) this.clock.at(this.clock.now, () => this.next());
    this.running = true;
  }
  private next(): void {
    const msg = this.pending.shift();
    if (!msg) { this.running = false; return; }
    const control = msg.control;
    let evals = 0;
    const gen = refineSteps(this.ev, { family: msg.family, control, t0: msg.t0, t1: msg.t1, toleranceUnits: msg.tolerance });
    const step = (): void => {
      if (this.cancelled.has(msg.jobId)) {
        this.wastedMs += this.clock.now - (this.cancelStamp.get(msg.jobId) ?? this.clock.now);
        this.cancelled.delete(msg.jobId);
        this.onmessage?.({ data: { type: 'cancelled', jobId: msg.jobId, control, evaluations: evals } });
        this.next();
        return;
      }
      const r = gen.next();
      if (r.done) {
        const p = r.value;
        this.onmessage?.({ data: { type: 'done', jobId: msg.jobId, params: p.params, positions: p.positions, control, evaluations: p.evaluations, batches: p.batches } });
        this.next();
        return;
      }
      evals += r.value;
      const dt = r.value * this.msPerEval;
      this.busyMs += dt;
      this.clock.at(this.clock.now + dt, step);
    };
    step();
  }
  terminate(): void { /* nothing to free */ }
}
