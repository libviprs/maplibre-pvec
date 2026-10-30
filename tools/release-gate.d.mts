export const REQUIRED_CONDITIONS: string[];
export function sha256(s: string): string;
export function apiSymbols(report: string): Record<string, Record<string, string>>;
export function classifyApiChange(frozen: Record<string, Record<string, string>>, current: Record<string, Record<string, string>>): "none" | "minor" | "major";
export function buildGate(root?: string): { conditions: { id: string; status: string }[] } & Record<string, unknown>;
export function evaluateRelease(gate: { conditions: { id: string; status: string }[] }): { ok: boolean; problems: string[] };
export function wiredLayerEvidence(root: string): { wasmOk: boolean; lossOk: boolean; wasmMeasured: Record<string, unknown>; lossMeasured: Record<string, unknown> };
