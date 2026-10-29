/** Identity of one refinement request. Every worker job carries it and every result is checked against it. */
export interface JobTag {
  entityId: number;
  generation: number;
  transformEpoch: number;
}

export type Verdict = 'accept' | 'stale-generation' | 'stale-epoch';

/**
 * Monotonic generation per entity, incremented on every refinement request and on every
 * transformEpoch change. A superseded generation or a stale epoch is refused at the upload
 * boundary (DrawTable.upload), before any GPU write.
 */
export class GenerationTracker {
  epoch = 0;
  /** Results refused because a newer generation exists. */
  discarded = 0;
  /** Results refused because the transform changed while they were in flight. */
  staleEpoch = 0;
  private gens = new Map<number, number>();

  next(entityId: number): JobTag {
    const generation = (this.gens.get(entityId) ?? 0) + 1;
    this.gens.set(entityId, generation);
    return { entityId, generation, transformEpoch: this.epoch };
  }

  current(entityId: number): number {
    return this.gens.get(entityId) ?? 0;
  }

  /** A new georeference or projection: all in-flight results become stale, and every entity moves to a new generation. */
  bumpEpoch(): number {
    this.epoch++;
    for (const [id, g] of this.gens) this.gens.set(id, g + 1);
    return this.epoch;
  }

  check(tag: JobTag): Verdict {
    if (tag.transformEpoch !== this.epoch) return 'stale-epoch';
    if (tag.generation !== this.current(tag.entityId)) return 'stale-generation';
    return 'accept';
  }

  /** The single gate: true when the result may be uploaded. Counts what it refuses. */
  admit(tag: JobTag): boolean {
    const v = this.check(tag);
    if (v === 'stale-epoch') this.staleEpoch++;
    else if (v === 'stale-generation') this.discarded++;
    return v === 'accept';
  }
}

export interface BufferRange {
  start: number;
  count: number;
}

export interface DrawRecord extends BufferRange {
  entityId: number;
  generation: number;
  transformEpoch: number;
}

/**
 * Entity to buffer-range mapping. upload() is the only writer: it admits the result, runs the GPU
 * write, and stages the record. endFrame() swaps the staged records into the live map in one step,
 * so a frame is drawn from one generation and one range per entity.
 */
export class DrawTable {
  private liveMap: ReadonlyMap<number, DrawRecord> = new Map();
  private staged = new Map<number, DrawRecord>();
  constructor(private readonly tracker: GenerationTracker) {}

  upload(tag: JobTag, range: BufferRange, write?: () => void): boolean {
    if (!this.tracker.admit(tag)) return false;
    write?.();
    this.staged.set(tag.entityId, { entityId: tag.entityId, generation: tag.generation, transformEpoch: tag.transformEpoch, ...range });
    return true;
  }

  /** Swap staged records into the live table. Returns the table the frame draws from. */
  endFrame(): ReadonlyMap<number, DrawRecord> {
    if (this.staged.size) {
      const next = new Map(this.liveMap);
      for (const [id, rec] of this.staged) next.set(id, rec);
      this.staged = new Map();
      this.liveMap = next;
    }
    return this.liveMap;
  }

  live(entityId: number): DrawRecord | undefined {
    return this.liveMap.get(entityId);
  }

  /** Per-frame audit: each entity has exactly one record, never from a stale epoch, and ranges are well-formed. */
  audit(): { entities: number; violations: string[] } {
    const violations: string[] = [];
    for (const [id, r] of this.liveMap) {
      if (r.entityId !== id) violations.push(`entity ${id} maps to a record for ${r.entityId}`);
      if (r.count < 0 || r.start < 0) violations.push(`entity ${id} has a malformed range`);
      if (r.transformEpoch > this.tracker.epoch) violations.push(`entity ${id} is from a future epoch`);
    }
    return { entities: this.liveMap.size, violations };
  }
}
