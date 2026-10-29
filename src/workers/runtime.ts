import { type CurveEvaluator, type CurveFamily, refineSteps } from './evaluator';
import type { JobTag } from '../refine/generation';

export type WorkerIn =
  | { type: 'init'; module?: WebAssembly.Module | undefined; shared?: boolean | undefined }
  | { type: 'job'; jobId: number; family: CurveFamily; control: Float64Array; t0: number; t1: number; chordUnits: number; tag: JobTag }
  | { type: 'cancel'; jobId: number };

export type WorkerOut =
  | { type: 'done'; jobId: number; params: Float64Array; positions: Float64Array; control: Float64Array; evaluations: number; batches: number }
  | { type: 'cancelled'; jobId: number; control: Float64Array; evaluations: number }
  | { type: 'error'; jobId: number; message: string; control: Float64Array };

/** The part of a Worker the pool uses, so the pool runs against a real Worker, a MessageChannel or a virtual-time double. */
export interface WorkerLike {
  postMessage(msg: WorkerIn, transfer?: Transferable[]): void;
  onmessage: ((e: { data: WorkerOut }) => void) | null;
  terminate(): void;
}

/**
 * Worker-side job loop. It runs the evaluator one packed batch at a time and yields between
 * batches, which is where a cancel message is seen. Results go back in the transfer list so
 * nothing is structured-clone copied.
 */
export class WorkerRuntime {
  private cancelled = new Set<number>();
  /** Payload buffers that were still attached after posting (should stay 0). */
  detachFailures = 0;
  constructor(
    private readonly evaluator: CurveEvaluator,
    private readonly post: (msg: WorkerOut, transfer: Transferable[]) => void,
    private readonly opts: { yield?: (() => Promise<void>) | undefined; shared?: boolean | undefined } = {},
  ) {}

  onMessage(msg: WorkerIn): void {
    if (msg.type === 'init') this.opts.shared = msg.shared === true;
    else if (msg.type === 'cancel') this.cancelled.add(msg.jobId);
    else if (msg.type === 'job') void this.run(msg);
  }

  private async run(msg: Extract<WorkerIn, { type: 'job' }>): Promise<void> {
    const yieldFn = this.opts.yield ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
    try {
      const gen = refineSteps(this.evaluator, { family: msg.family, control: msg.control, t0: msg.t0, t1: msg.t1, toleranceUnits: msg.chordUnits });
      let evals = 0;
      for (;;) {
        if (this.cancelled.delete(msg.jobId)) {
          this.post({ type: 'cancelled', jobId: msg.jobId, control: msg.control, evaluations: evals }, [msg.control.buffer]);
          return;
        }
        const r = gen.next();
        if (r.done) {
          let { params, positions } = r.value;
          if (this.opts.shared && typeof SharedArrayBuffer !== 'undefined') {
            const sp = new Float64Array(new SharedArrayBuffer(params.byteLength)); sp.set(params); params = sp;
            const sx = new Float64Array(new SharedArrayBuffer(positions.byteLength)); sx.set(positions); positions = sx;
          }
          const transfer: Transferable[] = [msg.control.buffer];
          if (!this.opts.shared) transfer.push(params.buffer as ArrayBuffer, positions.buffer as ArrayBuffer);
          const out: WorkerOut = { type: 'done', jobId: msg.jobId, params, positions, control: msg.control, evaluations: r.value.evaluations, batches: r.value.batches };
          this.post(out, transfer);
          if (msg.control.buffer.byteLength !== 0 || (!this.opts.shared && positions.buffer.byteLength !== 0)) this.detachFailures++;
          return;
        }
        evals += r.value;
        await yieldFn();
      }
    } catch (e) {
      this.post({ type: 'error', jobId: msg.jobId, message: e instanceof Error ? e.message : String(e), control: msg.control }, [msg.control.buffer]);
    }
  }
}

/** What a worker script gives the runtime: builds the evaluator from the compiled module the pool posts. */
export type EvaluatorFactory = (module: WebAssembly.Module | undefined) => Promise<CurveEvaluator>;

/**
 * Entry for a real worker script: `installWorker(self, factory)`. The factory is the shared PVec
 * WASM evaluator; its artifact is not released yet (docs/deferred.md), so tests use a double.
 */
export function installWorker(
  scope: { onmessage: ((e: { data: WorkerIn }) => void) | null; postMessage(m: unknown, t: Transferable[]): void },
  factory: EvaluatorFactory,
): void {
  let runtime: WorkerRuntime | undefined;
  const queued: WorkerIn[] = [];
  scope.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'init') {
      void factory(m.module).then((ev) => {
        runtime = new WorkerRuntime(ev, (out, t) => scope.postMessage(out, t), { shared: m.shared });
        for (const q of queued.splice(0)) runtime.onMessage(q);
      });
    } else if (runtime) runtime.onMessage(m);
    else queued.push(m);
  };
}
