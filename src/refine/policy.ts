import { REFINE_DEFAULTS } from '../config/defaults';
import { type CurveRef, type TransformPipeline, errorOfTessellation } from '../transform/screen_error';

export interface PolicyEntity {
  curve: CurveRef;
  /** The tessellation on screen, or null while only the Tier 0 preview is displayed. */
  displayed: { params: Float64Array; generation: number } | null;
}

export type Action = 'refine' | 'coarsen' | 'keep';
export interface Decision { action: Action; errorPx: number }

export interface PolicyOptions {
  navigating?: boolean;
  /** Error of the displayed tessellation in device px. Defaults to the post-transform measurement. */
  measure?: (entity: PolicyEntity, pipeline: TransformPipeline) => number;
}

/** Post-transform error of the displayed tessellation: source -> GIS -> projection -> camera -> device px. */
export function measureDisplayedError(e: PolicyEntity, pipeline: TransformPipeline): number {
  if (!e.displayed) return Infinity;
  return errorOfTessellation(Array.from(e.displayed.params), e.curve, pipeline, REFINE_DEFAULTS.measureSamples);
}

/**
 * Refine when the measured error exceeds the refine threshold (the navigating threshold while the
 * camera moves), coarsen below the coarsen threshold, keep inside the 4x band. A preview-only
 * entity (generation 0) always refines.
 */
export function needsRefinement(e: PolicyEntity, displayedGeneration: number, pipeline: TransformPipeline, o: PolicyOptions = {}): Decision {
  if (displayedGeneration === 0 || !e.displayed) return { action: 'refine', errorPx: Infinity };
  const errorPx = (o.measure ?? measureDisplayedError)(e, pipeline);
  const limit = o.navigating ? REFINE_DEFAULTS.navigatingPx : REFINE_DEFAULTS.refinePx;
  if (errorPx > limit) return { action: 'refine', errorPx };
  if (!o.navigating && errorPx < REFINE_DEFAULTS.coarsenPx) return { action: 'coarsen', errorPx };
  return { action: 'keep', errorPx };
}

/**
 * Walks entities in descending projected-area order inside a per-frame time budget and resumes
 * where it stopped on the next frame. The clock is read every `CHECK_EVERY` entities.
 */
export class PolicySweep {
  private order: Uint32Array;
  private cursor = 0;
  completedSweeps = 0;
  private static readonly CHECK_EVERY = 16;

  constructor(
    readonly count: number,
    areaOf: (i: number) => number,
    private readonly evaluate: (i: number) => Action,
    private readonly o: { budgetMs: number; now: () => number; onSweepComplete?: () => void },
  ) {
    this.order = new Uint32Array(count);
    this.resort(areaOf);
  }

  /** Re-sort the visiting order, descending by area. Run between sweeps. */
  resort(areaOf: (i: number) => number): void {
    const area = new Float64Array(this.count);
    for (let i = 0; i < this.count; i++) { area[i] = areaOf(i); this.order[i] = i; }
    this.order.sort((a, b) => area[b]! - area[a]!);
  }

  /** Restart from the largest entity. */
  restart(): void { this.cursor = 0; }

  /** Evaluate entities until the budget is spent or the sweep ends. Returns how many were evaluated. */
  runFrame(): number {
    const start = this.o.now();
    let n = 0;
    while (this.cursor < this.count) {
      this.evaluate(this.order[this.cursor++]!);
      n++;
      if (n % PolicySweep.CHECK_EVERY === 0 && this.o.now() - start >= this.o.budgetMs) break;
    }
    if (this.cursor >= this.count) {
      this.cursor = 0;
      this.completedSweeps++;
      this.o.onSweepComplete?.();
    }
    return n;
  }
}
