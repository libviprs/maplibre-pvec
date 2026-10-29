export interface Environment {
  browser: string;
  browserVersion: string;
  cpu: string;
  gpuRenderer: string;
  softwareRenderer: boolean;
  crossOriginIsolated: boolean;
  platform: string;
}
export type Threshold = { op: "<=" | ">="; limit: number } | { op: "info" };
export interface Metric {
  case: string;
  name: string;
  value: number;
  baseline: number;
  threshold: Threshold;
}
export interface BenchResult {
  schema: 1;
  commit: string;
  date: string;
  environment: Environment;
  corpus: { file: string; cases: number };
  subject: string;
  runs: Record<string, Record<string, number[]>>;
  variance: { limit: number; ok: boolean; failures: string[] };
  metrics: Metric[];
}

// arm64 container by default, native x86_64 only on the docker host. Rosetta is never accepted.
export const PLATFORMS = ["linux/arm64", "linux/x86_64 native"];
const ENV_KEYS = ["browser", "browserVersion", "cpu", "gpuRenderer", "crossOriginIsolated", "platform"] as const;

export function validateResult(r: unknown): string[] {
  const errors: string[] = [];
  const res = r as Partial<BenchResult> | null;
  const env = res?.environment as Partial<Environment> | undefined;
  if (!env || typeof env !== "object") return ["result has no environment block"];
  for (const k of ENV_KEYS) {
    if (env[k] === undefined || env[k] === "") errors.push(`environment.${k} is missing`);
  }
  if (env.platform !== undefined && !PLATFORMS.includes(env.platform)) {
    errors.push(`environment.platform ${JSON.stringify(env.platform)} must be one of ${PLATFORMS.join(", ")}`);
  }
  if (/swiftshader|llvmpipe|software|softpipe/i.test(env.gpuRenderer ?? "") && env.softwareRenderer !== true) {
    errors.push("environment.softwareRenderer must be true for a software GL renderer, numbers are not hardware numbers");
  }
  if (!res?.variance || res.variance.ok !== true) errors.push("variance check did not pass, the harness is not stable enough to quote");
  for (const [i, m] of (res?.metrics ?? []).entries()) {
    const mm = m as Partial<Metric>;
    for (const k of ["case", "baseline", "threshold"] as const) {
      if (mm[k] === undefined) errors.push(`metrics[${i}] (${mm.name ?? "?"}) is missing ${k}`);
    }
  }
  return errors;
}

export function evaluateMetrics(metrics: Metric[]): string[] {
  const out: string[] = [];
  for (const m of metrics) {
    const t = m.threshold;
    if (t.op === "info") continue;
    const ok = t.op === "<=" ? m.value <= t.limit : m.value >= t.limit;
    if (!ok) out.push(`${m.case}: ${m.name} measured ${m.value}, threshold ${t.op} ${t.limit} (baseline ${m.baseline})`);
  }
  return out;
}
