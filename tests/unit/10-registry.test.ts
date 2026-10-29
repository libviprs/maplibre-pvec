import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CorpusVerificationError,
  InvalidEvidenceClassError,
  exitStatus,
  loadRegistry,
  runSummary,
} from "../fixtures/registry";
import {
  CLAIMS,
  ClaimRefusedError,
  EVIDENCE_CLASSES,
  assertClaim,
  gatingFor,
} from "../fixtures/evidence";
import { memorySource, sha256Hex, type CorpusPin } from "../fixtures/source";
import { fsSource } from "../fixtures/node";

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(here, "..", "fixtures", "corpus");
const pin = JSON.parse(readFileSync(join(here, "..", "fixtures", "pin.json"), "utf8")) as CorpusPin;

async function files(): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const src = fsSource(corpusDir);
  const manifest = await src.read("r0-open/manifest.json");
  out.set("r0-open/manifest.json", manifest);
  for (const p of ["r0-open/quarantine.json", "release/r0-open-1/manifest.json"]) out.set(p, await src.read(p));
  const m = JSON.parse(new TextDecoder().decode(manifest)) as { fixtures: { id: string }[] };
  for (const f of m.fixtures) {
    const e = `r0-open/fixtures/${f.id}/expected.math.json`;
    out.set(e, await src.read(e));
    try {
      const s = `release/r0-open-1/signatures/${f.id}.signature.json`;
      out.set(s, await src.read(s));
    } catch {
      /* the refused fixture ships no signature */
    }
  }
  return out;
}

function flip(bytes: Uint8Array): Uint8Array {
  const c = bytes.slice();
  c[c.length - 2] = c[c.length - 2]! ^ 0x01;
  return c;
}

async function repin(map: Map<string, Uint8Array>): Promise<CorpusPin> {
  return { ...pin, manifestSha256: await sha256Hex(map.get("r0-open/manifest.json")!) };
}

describe("#10 registry resolves the pinned corpus", () => {
  it("loads every accepted fixture from disk with its identity, expectations and class", async () => {
    const reg = await loadRegistry(fsSource(corpusDir), pin);
    console.log(`corpus revision: ${reg.revision} (manifest ${reg.manifestSha256})`);
    expect(reg.revision).toBe("r0-open");
    expect(reg.fixtures).toHaveLength(30);
    for (const f of reg.fixtures) {
      expect(f.evidenceClass).toBe("KNOWN_TRUTH_EXACT");
      expect(f.sourceDwg.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(f.sourceDwg.path).toMatch(/source\.dwg$/);
      expect(f.expected.path).toMatch(/expected\.math\.json$/);
      expect(f.entities.length).toBeGreaterThan(0);
      for (const e of f.entities) {
        expect(e.id).toBeTruthy();
        expect(e.type).toBeTruthy();
      }
    }
    const nested = reg.fixtures.find((f) => f.id === "nested-blocks-001")!;
    expect(nested.entities).toEqual([{ id: "nested-blocks-001", type: "line" }]);
  });

  it("records the canonical pvec as pending rather than inventing one", async () => {
    const reg = await loadRegistry(fsSource(corpusDir), pin);
    for (const f of reg.fixtures) expect(f.canonicalPvec).toEqual({ status: "PENDING", waitsOn: "libviprs/pvec#1 P2.4" });
  });

  it("carries the signature of every fixture the converter accepted and none for the refused one", async () => {
    const reg = await loadRegistry(fsSource(corpusDir), pin);
    expect(reg.fixtures.filter((f) => f.signature === null).map((f) => f.id)).toEqual(["near-singular-001"]);
  });
});

describe("#10 the loader fails closed", () => {
  it("turns red on a corrupted expected.math.json and names the path", async () => {
    const m = await files();
    const p = "r0-open/fixtures/line-001/expected.math.json";
    m.set(p, flip(m.get(p)!));
    const err = await loadRegistry(memorySource(m), pin).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CorpusVerificationError);
    expect((err as CorpusVerificationError).path).toBe(p);
    expect((err as Error).message).toContain("expected");
  });

  it("turns red on a corrupted signature", async () => {
    const m = await files();
    const p = "release/r0-open-1/signatures/circle-001.signature.json";
    m.set(p, flip(m.get(p)!));
    await expect(loadRegistry(memorySource(m), pin)).rejects.toBeInstanceOf(CorpusVerificationError);
  });

  it("turns red when the manifest differs from the pin", async () => {
    const m = await files();
    m.set("r0-open/manifest.json", flip(m.get("r0-open/manifest.json")!));
    await expect(loadRegistry(memorySource(m), pin)).rejects.toBeInstanceOf(CorpusVerificationError);
  });

  it("turns red when an artifact is missing", async () => {
    const m = await files();
    m.delete("r0-open/fixtures/line-001/expected.math.json");
    await expect(loadRegistry(memorySource(m), pin)).rejects.toBeInstanceOf(CorpusVerificationError);
  });

  it("turns red when the pinned revision is not the one the manifest declares", async () => {
    await expect(loadRegistry(fsSource(corpusDir), { ...pin, revision: "r9-open" })).rejects.toBeInstanceOf(
      CorpusVerificationError,
    );
  });
});

describe("#10 evidence classes", () => {
  async function withManifest(edit: (f: Record<string, unknown>) => void): Promise<[Map<string, Uint8Array>, CorpusPin]> {
    const m = await files();
    const doc = JSON.parse(new TextDecoder().decode(m.get("r0-open/manifest.json")!)) as { fixtures: Record<string, unknown>[] };
    edit(doc.fixtures[0]!);
    m.set("r0-open/manifest.json", new TextEncoder().encode(JSON.stringify(doc)));
    return [m, await repin(m)];
  }

  it("names exactly the four classes", () => {
    expect([...EVIDENCE_CLASSES]).toEqual([
      "KNOWN_TRUTH_EXACT",
      "DUAL_ORACLE_EQUIVALENT",
      "REAL_WORLD_DIFFERENTIAL",
      "QUARANTINED",
    ]);
  });

  it("rejects a fixture whose class is absent", async () => {
    const [m, p] = await withManifest((f) => delete f.evidence_class);
    await expect(loadRegistry(memorySource(m), p)).rejects.toBeInstanceOf(InvalidEvidenceClassError);
  });

  it("rejects a fixture whose class is not one of the four", async () => {
    const [m, p] = await withManifest((f) => (f.evidence_class = "KNOWN_TRUTH_MOSTLY"));
    await expect(loadRegistry(memorySource(m), p)).rejects.toBeInstanceOf(InvalidEvidenceClassError);
  });

  it("rejects a manifest class that disagrees with the record's own class", async () => {
    const [m, p] = await withManifest((f) => (f.evidence_class = "DUAL_ORACLE_EQUIVALENT"));
    await expect(loadRegistry(memorySource(m), p)).rejects.toBeInstanceOf(CorpusVerificationError);
  });

  it("refuses a structural exactness claim against a dual-oracle fixture", async () => {
    const reg = await loadRegistry(fsSource(corpusDir), pin);
    const f = reg.fixtures[0]!;
    expect(() => assertClaim(f, "structural_exactness")).not.toThrow();
    const reclassified = { ...f, evidenceClass: "DUAL_ORACLE_EQUIVALENT" as const };
    expect(() => assertClaim(reclassified, "structural_exactness")).toThrow(ClaimRefusedError);
    expect(() => assertClaim(reclassified, "geometric_exactness")).toThrow(ClaimRefusedError);
  });

  it("states which claims each class may support, with display fidelity separate", () => {
    expect([...CLAIMS]).toEqual(["structural_exactness", "geometric_exactness", "display_fidelity", "regression"]);
    expect(() => assertClaim({ id: "x", evidenceClass: "REAL_WORLD_DIFFERENTIAL" }, "geometric_exactness")).toThrow(
      ClaimRefusedError,
    );
    expect(() => assertClaim({ id: "x", evidenceClass: "QUARANTINED" }, "regression")).toThrow(ClaimRefusedError);
  });
});

describe("#10 gating and the run summary", () => {
  it("gates only known-truth and dual-oracle fixtures", () => {
    expect(gatingFor("KNOWN_TRUTH_EXACT")).toBe("gate");
    expect(gatingFor("DUAL_ORACLE_EQUIVALENT")).toBe("gate");
    expect(gatingFor("REAL_WORLD_DIFFERENTIAL")).toBe("report");
    expect(gatingFor("QUARANTINED")).toBe("excluded");
  });

  it("lists quarantined fixtures with their reason and never lets them change the exit status", async () => {
    const reg = await loadRegistry(fsSource(corpusDir), pin);
    expect(reg.quarantined.map((q) => [q.id, q.reason])).toEqual([
      ["general-affine-001", "UNSUPPORTED_ENTITY"],
      ["shear-001", "UNSUPPORTED_ENTITY"],
      ["singular-001", "UNSUPPORTED_ENTITY"],
    ]);
    expect(exitStatus(reg, [{ fixtureId: "shear-001", passed: false }])).toBe(0);
    expect(exitStatus(reg, [{ fixtureId: "line-001", passed: false }])).toBe(1);
    expect(exitStatus(reg, [{ fixtureId: "line-001", passed: true }])).toBe(0);
  });

  it("refuses a result for a fixture the registry does not know", async () => {
    const reg = await loadRegistry(fsSource(corpusDir), pin);
    expect(() => exitStatus(reg, [{ fixtureId: "nope-001", passed: true }])).toThrow(/nope-001/);
  });

  it("states the corpus revision and the converter versions recorded in the manifest", async () => {
    const reg = await loadRegistry(fsSource(corpusDir), pin);
    const text = runSummary(reg);
    expect(text).toContain("corpus revision: r0-open");
    expect(text).toContain("PVec numeric policy v1");
    expect(text).toContain("ACadSharp 3.7.1+d7dc111");
    expect(text).toContain("QUARANTINED shear-001 UNSUPPORTED_ENTITY");
    expect(text).toContain("gating: 30");
    expect(text).toContain("canonical pvec pending: 30");
  });
});
