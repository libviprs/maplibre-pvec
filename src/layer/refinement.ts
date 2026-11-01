import { REFINE_DEFAULTS } from "../config/defaults";
import { Tier0Decoder, type BlockCursor, type Bounds, type EntityDraw, type Geometry } from "../decode/tier0";
import type { RefinementEvent } from "../diagnostics/events";

export type Box = readonly [number, number, number, number];

/** What the camera shows now: the source window under the canvas and device pixels per source unit near its centre. */
export interface RefineView {
  window: Box;
  pxPerSource: number;
}

/** The module's walk of the file at a chord asked for, in source units. The caller closes the cursor. */
export interface RefinementSource {
  cursorFor(window: Box, chord: number): BlockCursor & { close(): void };
}

export interface RefinerInit {
  source: RefinementSource;
  /** Undefined while there is nothing to read (no georeference, no canvas). */
  view(): RefineView | undefined;
  /** Source units of one pixel of the view the Tier 0 errors are declared in. */
  tier0Px: number;
  /** How long the camera has to rest before a run starts, ms. Defaults to the policy's idle time. */
  idleMs?: number | undefined;
  /** The whole current set of draws, with the refined entities replaced. */
  setDraws(draws: readonly EntityDraw[]): void;
  report(e: RefinementEvent): void;
}

interface Shown {
  draw: EntityDraw;
  /** Tolerance in source units the polyline was tessellated at. 0 for an entity that is exact. */
  chord: number;
  generation: number;
}

const meets = (a: Bounds, w: Box): boolean => a.minX <= w[2] && a.maxX >= w[0] && a.minY <= w[3] && a.maxY >= w[1];

const sameGeometry = (a: Geometry, b: Geometry): boolean => {
  if (!("points" in a) || !("points" in b) || a.points.length !== b.points.length) return false;
  for (let i = 0; i < a.points.length; i++) if (a.points[i] !== b.points[i]) return false;
  return true;
};

/**
 * Tier 1 refinement of the strokes the Tier 0 decode put on screen. When the camera has rested for `idleMs` the entities in view
 * whose displayed error, in device pixels, is above the refine threshold are walked again by the module at the target error for the
 * current scale (the policy of docs/tier0-refinement-lifecycle.md), their polylines are replaced, and each replacement is reported
 * with a generation that only goes up. An entity the module returns unchanged is exact and is never asked again. A camera move, a
 * new georeference or `cancel` drops the run in flight, so a stale result is never drawn or reported.
 */
export class TierRefiner {
  private readonly shown = new Map<string, Shown>();
  private token = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private cursor: { close(): void } | undefined;
  private waiters: Array<() => void> = [];

  constructor(private readonly o: RefinerInit) {}

  /** The Tier 0 draws now on screen. Starts a first run, because the camera may already be closer than the declared errors allow. */
  start(draws: readonly EntityDraw[]): void {
    this.shown.clear();
    for (const d of draws) this.shown.set(d.entityId, { draw: d, chord: d.kind === "preview" ? d.declaredErrorPx * this.o.tier0Px : 0, generation: 0 });
    this.settle();
  }

  /** The camera or the georeference changed: whatever runs is dropped and a run starts after the camera has rested. */
  settle(): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run(this.token);
    }, this.o.idleMs ?? REFINE_DEFAULTS.idleMs);
  }

  /** Drops the run in flight and the one waiting. */
  cancel(): void {
    this.token++;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.cursor?.close();
    this.cursor = undefined;
    this.release();
  }

  /** The generation on screen for an entity: 0 for the Tier 0 draw. */
  generationOf(entityId: string): number {
    return this.shown.get(entityId)?.generation ?? 0;
  }

  /** Resolves when nothing is waiting to run and nothing runs. */
  whenIdle(): Promise<void> {
    return this.timer === undefined && !this.running ? Promise.resolve() : new Promise((resolve) => void this.waiters.push(resolve));
  }

  private release(): void {
    if (this.timer !== undefined || this.running) return;
    for (const w of this.waiters.splice(0)) w();
  }

  private async run(token: number): Promise<void> {
    this.running = true;
    try {
      await this.refine(token);
    } finally {
      this.running = false;
      this.release();
    }
  }

  private async refine(token: number): Promise<void> {
    const view = this.o.view();
    const scale = view?.pxPerSource ?? 0;
    if (!view || !(Number.isFinite(scale) && scale > 0)) return;
    const wanted = (s: Shown): boolean => s.chord * scale > REFINE_DEFAULTS.refinePx && meets(s.draw.bounds, view.window);
    if (![...this.shown.values()].some(wanted)) return;
    const chord = REFINE_DEFAULTS.targetPx / scale;
    const cursor = this.o.source.cursorFor(view.window, chord);
    this.cursor = cursor;
    const replaced: Array<{ id: string; draw: EntityDraw; priorErrorPx: number }> = [];
    const decoder = new Tier0Decoder();
    try {
      for (let slice = decoder.decodeSlice(cursor); slice; slice = decoder.decodeSlice(cursor)) {
        for (const d of slice.draws) {
          const cur = this.shown.get(d.entityId);
          if (!cur || !wanted(cur)) continue;
          if (sameGeometry(cur.draw.geometry, d.geometry)) cur.chord = 0;
          else replaced.push({ id: d.entityId, draw: d, priorErrorPx: cur.chord * scale });
        }
        await new Promise<void>((resolve) => void setTimeout(resolve, 0));
        if (token !== this.token) return;
      }
    } finally {
      if (this.cursor === cursor) this.cursor = undefined;
      cursor.close();
    }
    if (token !== this.token || !replaced.length) return;
    const events: RefinementEvent[] = [];
    for (const r of replaced) {
      const cur = this.shown.get(r.id)!;
      cur.generation++;
      cur.chord = chord;
      cur.draw = { ...r.draw, generation: cur.generation, ...(r.draw.kind === "preview" ? { declaredErrorPx: chord / this.o.tier0Px } : {}) } as EntityDraw;
      events.push({ entityId: r.id, generation: cur.generation, priorErrorPx: r.priorErrorPx, nextErrorPx: chord * scale });
    }
    this.o.setDraws([...this.shown.values()].map((s) => s.draw));
    for (const e of events) this.o.report(e);
  }
}
