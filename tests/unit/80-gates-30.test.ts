import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const json = <T>(p: string): T => JSON.parse(readFileSync(join(root, p), "utf8")) as T;

interface Gate { conditions: { id: string; status: string; measured: Record<string, unknown> }[] }
const corpus = json<{ cases: { fixtureId: string; pvec: { status: string; bytes?: number; sha256?: string } }[] }>("bench/corpus/corpus.json");
const gate = json<Gate>("release/v1-gate.json");

describe("#80 all gates green on the frozen corpus counts 30 of 30", () => {
  it("every one of the 30 cases has real .pvec bytes with a size and digest", () => {
    expect(corpus.cases).toHaveLength(30);
    const present = corpus.cases.filter((c) => c.pvec.status === "PRESENT");
    expect(present.map((c) => c.fixtureId)).toHaveLength(30);
    for (const c of present) {
      expect(c.pvec.bytes, c.fixtureId).toBeGreaterThan(0);
      expect(c.pvec.sha256, c.fixtureId).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("the gate row measures 30 of 30, and is met only when the measurement says so", () => {
    const row = gate.conditions.find((c) => c.id === "gates_green_frozen_corpus")!;
    expect(row.measured["casesWithPvecBytes"]).toBe(30);
    expect(row.measured["notEmittedByPvec"]).toBe(0);
    expect(row.measured["cases"]).toBe(30);
    expect(row.measured["varianceOk"]).toBe(true);
    expect(row.status).toBe("met");
  });

  it("the pass set is all 30 and none of them is QUARANTINED", () => {
    const row = gate.conditions.find((c) => c.id === "no_quarantined_in_pass_set")!;
    expect(row.measured["passSetCases"]).toBe(30);
    expect(row.measured["quarantined"]).toBe(0);
  });
});
