import type { Registry } from "../../tests/fixtures/registry";
import { viewportScript, type ViewportScript } from "./viewport";

export const CLASSES = ["known-truth", "architectural", "mep", "industrial", "huge", "spline-heavy", "adversarial"] as const;
export type CaseClass = (typeof CLASSES)[number];

// A curve is an analytic non-line entity. Polylines are counted as entities only.
const CURVE_CLASSES = ["circle", "circular_arc", "ellipse", "elliptical_arc", "bezier", "bspline", "nurbs"];

export interface Case {
  fixtureId: string;
  class: CaseClass;
  evidenceClass: string;
  entities: Record<string, number>;
  curves: { total: number; byClass: Record<string, number> };
  /** PRESENT: pvec emitted the artifact. NOT_EMITTED: pvec refused, `note` is its reason. PENDING: no index yet. */
  pvec:
    | { status: "PENDING"; bytes: null; sha256: null; note: string }
    | { status: "PRESENT"; bytes: number; sha256: string; note: string }
    | { status: "NOT_EMITTED"; bytes: null; sha256: null; note: string };
  viewport: ViewportScript;
}
export interface RasterCase {
  id: string;
  /** How many scans sit over the strokes: 1 or 10. */
  scans: number;
  /** What draws the strokes. The real cursor is not wired into the layer yet, so this says so. */
  strokes: string;
  /** One A0 at 400 dpi, in 512 px tiles. `tilesSha256` is the digest of bench/hw/raster-tiles.json. */
  scan: { width: number; height: number; dpi: number; edge: number; tilesSha256: string };
}
export interface Corpus {
  revision: string;
  manifestSha256: string;
  cases: Case[];
  rasterCases?: RasterCase[];
}

/** A0 landscape, 1189 by 841 mm, at 400 dpi. */
export const A0_400DPI = { width: 18724, height: 13244, dpi: 400 } as const;

export function buildRasterCases(tilesSha256: string): RasterCase[] {
  return [1, 10].map((scans) => ({
    id: `architectural-1e5+${scans}-${scans === 1 ? "scan" : "scans"}`,
    scans,
    strokes: "1e5 segments from the stand-in cursor (the real Tier 0 cursor is not wired into the layer yet, docs/deferred.md)",
    scan: { ...A0_400DPI, edge: 512, tilesSha256 },
  }));
}

function pvecOf(c: Registry["fixtures"][number]["canonicalPvec"]): Case["pvec"] {
  if (c.status === "PRESENT") return { status: "PRESENT", bytes: c.bytes, sha256: c.sha256, note: c.path };
  if (c.status === "NOT_EMITTED") return { status: "NOT_EMITTED", bytes: null, sha256: null, note: c.reason };
  return { status: "PENDING", bytes: null, sha256: null, note: c.waitsOn };
}

export function buildCorpus(reg: Registry, rasterTilesSha256?: string): Corpus {
  const cases = reg.fixtures
    .filter((f) => f.gating !== "excluded")
    .map((f): Case => {
      const entities: Record<string, number> = {};
      for (const e of f.entities) entities[e.type] = (entities[e.type] ?? 0) + 1;
      const byClass = Object.fromEntries(Object.entries(entities).filter(([k]) => CURVE_CLASSES.includes(k)));
      return {
        fixtureId: f.id,
        // The pinned open corpus only has synthetic authored fixtures. The other classes are added
        // as fixtures are accepted upstream (docs/deferred.md, issue 34).
        class: "known-truth",
        evidenceClass: f.evidenceClass,
        entities,
        curves: { total: Object.values(byClass).reduce((a, b) => a + b, 0), byClass },
        pvec: pvecOf(f.canonicalPvec),
        viewport: viewportScript(f.id),
      };
    });
  return { revision: reg.revision, manifestSha256: reg.manifestSha256, cases, ...(rasterTilesSha256 ? { rasterCases: buildRasterCases(rasterTilesSha256) } : {}) };
}

export function validateCorpus(corpus: Corpus, reg: Registry): { errors: string[]; missingClasses: CaseClass[] } {
  const errors: string[] = [];
  const seen = new Set<string>();
  if (corpus.revision !== reg.revision || corpus.manifestSha256 !== reg.manifestSha256) {
    errors.push(`corpus pins ${corpus.revision} ${corpus.manifestSha256}, upstream is ${reg.revision} ${reg.manifestSha256}`);
  }
  for (const c of corpus.cases) {
    const id = c.fixtureId;
    if (seen.has(id)) errors.push(`${id}: listed twice`);
    seen.add(id);
    if ((c.evidenceClass as string) === "QUARANTINED") errors.push(`${id}: evidence class QUARANTINED is excluded from the corpus`);
    const q = reg.quarantined.find((x) => x.id === id);
    if (q) {
      errors.push(`${id}: quarantined or excluded upstream (${q.reason})`);
      continue;
    }
    const f = reg.fixtures.find((x) => x.id === id);
    if (!f) {
      errors.push(`${id}: fixture id does not resolve in the upstream corpus manifest`);
      continue;
    }
    if (f.evidenceClass !== c.evidenceClass) {
      errors.push(`${id}: evidence class ${c.evidenceClass} differs from the manifest's ${f.evidenceClass}`);
    }
    const want = buildCorpus({ ...reg, fixtures: [f] }).cases[0]!;
    if (!sameCounts(want.entities, c.entities)) {
      errors.push(`${id}: entities ${JSON.stringify(c.entities)} differ from the fixture record ${JSON.stringify(want.entities)}`);
    }
    if (!sameCounts(want.curves.byClass, c.curves.byClass) || want.curves.total !== c.curves.total) {
      errors.push(`${id}: curve counts differ from the fixture record`);
    }
    const wantPvec = want.pvec;
    if (c.pvec.status !== wantPvec.status || c.pvec.bytes !== wantPvec.bytes || c.pvec.sha256 !== wantPvec.sha256) {
      errors.push(`${id}: pvec ${c.pvec.status} ${c.pvec.bytes} differs from what pvec's index pins (${wantPvec.status} ${wantPvec.bytes})`);
    }
  }
  return { errors, missingClasses: CLASSES.filter((k) => !corpus.cases.some((c) => c.class === k)) };
}

function sameCounts(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a).sort();
  return JSON.stringify(ka) === JSON.stringify(Object.keys(b).sort()) && ka.every((k) => a[k] === b[k]);
}
