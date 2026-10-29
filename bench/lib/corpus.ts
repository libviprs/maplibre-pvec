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
  pvec: { status: "PENDING"; bytes: null; waitsOn: string };
  viewport: ViewportScript;
}
export interface Corpus {
  revision: string;
  manifestSha256: string;
  cases: Case[];
}

export function buildCorpus(reg: Registry): Corpus {
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
        pvec: { status: "PENDING", bytes: null, waitsOn: f.canonicalPvec.waitsOn },
        viewport: viewportScript(f.id),
      };
    });
  return { revision: reg.revision, manifestSha256: reg.manifestSha256, cases };
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
    if (c.pvec.bytes !== null) errors.push(`${id}: pvec byte size ${c.pvec.bytes} was invented, the canonical pvec does not exist yet`);
  }
  return { errors, missingClasses: CLASSES.filter((k) => !corpus.cases.some((c) => c.class === k)) };
}

function sameCounts(a: Record<string, number>, b: Record<string, number>): boolean {
  const ka = Object.keys(a).sort();
  return JSON.stringify(ka) === JSON.stringify(Object.keys(b).sort()) && ka.every((k) => a[k] === b[k]);
}
