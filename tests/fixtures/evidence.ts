// The four evidence classes are defined once, in pvec-gold-fixtures ADR 0001. This file
// spells them the same way and says which claims each may support.
export const EVIDENCE_CLASSES = [
  "KNOWN_TRUTH_EXACT",
  "DUAL_ORACLE_EQUIVALENT",
  "REAL_WORLD_DIFFERENTIAL",
  "QUARANTINED",
] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export const CLAIMS = ["structural_exactness", "geometric_exactness", "display_fidelity", "regression"] as const;
export type Claim = (typeof CLAIMS)[number];

export function isEvidenceClass(v: unknown): v is EvidenceClass {
  return typeof v === "string" && (EVIDENCE_CLASSES as readonly string[]).includes(v);
}

// Converter agreement is never source truth, so a dual-oracle fixture carries no exactness claim.
const SUPPORTED: Record<EvidenceClass, readonly Claim[]> = {
  KNOWN_TRUTH_EXACT: ["structural_exactness", "geometric_exactness", "display_fidelity", "regression"],
  DUAL_ORACLE_EQUIVALENT: ["display_fidelity", "regression"],
  REAL_WORLD_DIFFERENTIAL: ["regression"],
  QUARANTINED: [],
};

export type Gating = "gate" | "report" | "excluded";

export function gatingFor(c: EvidenceClass): Gating {
  if (c === "KNOWN_TRUTH_EXACT" || c === "DUAL_ORACLE_EQUIVALENT") return "gate";
  return c === "REAL_WORLD_DIFFERENTIAL" ? "report" : "excluded";
}

export class ClaimRefusedError extends Error {
  constructor(id: string, cls: EvidenceClass, claim: Claim) {
    super(`fixture ${id} is ${cls} and cannot be cited for ${claim}`);
    this.name = "ClaimRefusedError";
  }
}

export function assertClaim(f: { id: string; evidenceClass: EvidenceClass }, claim: Claim): void {
  if (!SUPPORTED[f.evidenceClass].includes(claim)) throw new ClaimRefusedError(f.id, f.evidenceClass, claim);
}
