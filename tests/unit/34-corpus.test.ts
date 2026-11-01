import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { loadRegistry, type Registry } from "../fixtures/registry";
import { fsSource, loadPvecIndex } from "../fixtures/node";
import type { CorpusPin } from "../fixtures/source";
import { CLASSES, buildCorpus, validateCorpus, type Corpus } from "../../bench/lib/corpus";
import { viewportScript } from "../../bench/lib/viewport";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pin = JSON.parse(readFileSync(join(root, "tests/fixtures/pin.json"), "utf8")) as CorpusPin;
const corpus = JSON.parse(readFileSync(join(root, "bench/corpus/corpus.json"), "utf8")) as Corpus;
const schema = JSON.parse(readFileSync(join(root, "bench/corpus/corpus.schema.json"), "utf8"));
const reg: Registry = await loadRegistry(fsSource(join(root, "tests/fixtures/corpus")), pin, await loadPvecIndex(join(root, "tests/fixtures/pvec")));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("#34 corpus.json", () => {
  it("validates against the committed schema and the upstream manifest", () => {
    const ajv = new Ajv({ allErrors: true, strict: true });
    expect(ajv.validate(schema, corpus), JSON.stringify(ajv.errors)).toBe(true);
    expect(validateCorpus(corpus, reg).errors).toEqual([]);
  });

  it("is exactly what the builder derives from the pinned manifest", () => {
    const tiles = JSON.parse(readFileSync(join(root, "bench/hw/raster-tiles.json"), "utf8")) as { tilesSha256: string };
    expect(corpus).toEqual(buildCorpus(reg, tiles.tilesSha256));
  });

  it("states entity and curve counts from the fixture records, not an estimate", () => {
    for (const c of corpus.cases) {
      const f = reg.fixtures.find((x) => x.id === c.fixtureId)!;
      const total = Object.values(c.entities).reduce((a, b) => a + b, 0);
      expect(total, c.fixtureId).toBe(f.entities.length);
      expect(c.curves.total).toBeLessThanOrEqual(total);
    }
    const bs = corpus.cases.find((c) => c.fixtureId === "bspline-d3-001")!;
    expect(bs.entities.bspline).toBe(1);
    expect(bs.curves.total).toBe(1);
  });

  it("rejects a fixture id that does not resolve upstream", () => {
    const bad = clone(corpus);
    bad.cases[0]!.fixtureId = "no-such-fixture-001";
    expect(validateCorpus(bad, reg).errors.join("\n")).toMatch(/no-such-fixture-001.*does not resolve/);
  });

  it("rejects a quarantined or excluded fixture", () => {
    const bad = clone(corpus);
    bad.cases[0]!.fixtureId = "shear-001";
    const msg = validateCorpus(bad, reg).errors.join("\n");
    expect(msg).toMatch(/shear-001/);
    expect(msg).toMatch(/quarantined|excluded/);
    const q = clone(corpus);
    q.cases[0]!.evidenceClass = "QUARANTINED" as never;
    expect(validateCorpus(q, reg).errors.join("\n")).toMatch(/QUARANTINED/);
  });

  it("rejects an evidence class that disagrees with the manifest", () => {
    const bad = clone(corpus);
    bad.cases[0]!.evidenceClass = "DUAL_ORACLE_EQUIVALENT";
    expect(validateCorpus(bad, reg).errors.join("\n")).toMatch(/evidence class/);
  });

  it("rejects counts that differ from the fixture record", () => {
    const bad = clone(corpus);
    bad.cases[0]!.entities = { line: 99 };
    expect(validateCorpus(bad, reg).errors.join("\n")).toMatch(/entities/);
  });

  it("rejects a pvec size or digest that is not the one pvec's index pins", () => {
    const bad = clone(corpus);
    (bad.cases[0]!.pvec as { bytes: number | null }).bytes = 1234;
    expect(validateCorpus(bad, reg).errors.join("\n")).toMatch(/pvec/);
    const sha = clone(corpus);
    (sha.cases[0]!.pvec as { sha256: string | null }).sha256 = "0".repeat(64);
    expect(validateCorpus(sha, reg).errors.join("\n")).toMatch(/pvec/);
  });

  it("has real pvec bytes for 28 cases and pvec's own reason for the 2 it did not emit (#80)", () => {
    expect(corpus.cases.filter((c) => c.pvec.status === "PRESENT")).toHaveLength(28);
    expect(corpus.cases.filter((c) => c.pvec.status === "PENDING")).toHaveLength(0);
    const none = corpus.cases.filter((c) => c.pvec.status === "NOT_EMITTED");
    expect(none).toHaveLength(2);
    for (const c of none) expect(c.pvec.note, c.fixtureId).toContain(c.fixtureId);
  });

  it("names the classes that have no case yet instead of passing them silently", () => {
    const r = validateCorpus(corpus, reg);
    expect(r.missingClasses).toEqual(CLASSES.filter((c) => c !== "known-truth"));
  });

  it("fails the schema when a case lacks a viewport script", () => {
    const bad = clone(corpus) as unknown as { cases: Record<string, unknown>[] };
    delete bad.cases[0]!.viewport;
    expect(new Ajv({ strict: true }).validate(schema, bad)).toBe(false);
  });
});

describe("#34 viewport scripts", () => {
  it("are deterministic, carry a zoom ladder, pan path, bearing and pitch steps, and stay in the v1 envelope", () => {
    const a = viewportScript("line-001");
    expect(viewportScript("line-001")).toEqual(a);
    expect(a.zoomLadder.length).toBeGreaterThan(2);
    expect(a.panPath.length).toBeGreaterThan(10);
    expect(a.bearingSteps.length).toBeGreaterThan(1);
    expect(a.pitchSteps.length).toBeGreaterThan(1);
    expect(Math.max(...a.zoomLadder)).toBeLessThanOrEqual(22);
    expect(Math.abs(a.start.center[1])).toBeLessThanOrEqual(84);
  });
});
