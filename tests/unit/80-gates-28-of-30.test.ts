import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const json = <T>(p: string): T => JSON.parse(readFileSync(join(root, p), "utf8")) as T;

interface Gate { conditions: { id: string; status: string; measured: Record<string, unknown> }[] }
const corpus = json<{ cases: { fixtureId: string; pvec: { status: string; bytes?: number; sha256?: string } }[] }>("bench/corpus/corpus.json");
const gate = json<Gate>("release/v1-gate.json");

// pvec#200 (ADR 0017, amendment 2026-10-31, docs/CORPUS.md "Refusals by design"): 28 of the 30 fixtures are emitted, and
// pvec refuses the other two on purpose, so the row reads 28 of 30 with both named.
const BY_DESIGN = ["near-singular-001", "translation-001"];

describe("#80 all gates green on the frozen corpus counts 28 of 30 with the two by-design refusals named", () => {
  it("28 cases have real .pvec bytes with a size and digest, and the other two are the named refusals", () => {
    expect(corpus.cases).toHaveLength(30);
    const present = corpus.cases.filter((c) => c.pvec.status === "PRESENT");
    expect(present).toHaveLength(28);
    for (const c of present) {
      expect(c.pvec.bytes, c.fixtureId).toBeGreaterThan(0);
      expect(c.pvec.sha256, c.fixtureId).toMatch(/^[0-9a-f]{64}$/);
    }
    const refused = corpus.cases.filter((c) => c.pvec.status !== "PRESENT").map((c) => c.fixtureId).sort();
    expect(refused).toEqual(BY_DESIGN);
  });

  it("the gate row measures 28 of 30, names the refusals, and is met only when the measurement says so", () => {
    const row = gate.conditions.find((c) => c.id === "gates_green_frozen_corpus")!;
    expect(row.measured["casesWithPvecBytes"]).toBe(28);
    expect(row.measured["notEmittedByPvec"]).toBe(2);
    expect(row.measured["cases"]).toBe(30);
    expect(row.measured["refusedByDesign"]).toEqual(BY_DESIGN);
    expect(row.measured["varianceOk"]).toBe(true);
    expect(row.status).toBe("met");
  });

  it("the pass set is the 28 emitted cases and none of them is QUARANTINED", () => {
    const row = gate.conditions.find((c) => c.id === "no_quarantined_in_pass_set")!;
    expect(row.measured["passSetCases"]).toBe(28);
    expect(row.measured["quarantined"]).toBe(0);
  });
});
