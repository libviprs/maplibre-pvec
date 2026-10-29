export const MIN_RUNS = 5;

// Sample standard deviation over the mean.
export function relativeSpread(values: number[]): number {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2 || mean === 0) return 0;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance) / Math.abs(mean);
}

export function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}

export function checkVariance(runs: Record<string, number[]>, limit: number): { limit: number; ok: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const [key, values] of Object.entries(runs)) {
    if (values.length < MIN_RUNS) failures.push(`${key}: ${values.length} runs, need ${MIN_RUNS}`);
    else {
      const s = relativeSpread(values);
      if (s > limit) failures.push(`${key}: run-to-run spread ${(s * 100).toFixed(1)} % exceeds ${(limit * 100).toFixed(0)} %`);
    }
  }
  return { limit, ok: failures.length === 0, failures };
}
