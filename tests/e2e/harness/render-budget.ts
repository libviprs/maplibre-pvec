import { expect, test } from "@playwright/test";
import { cpus, loadavg } from "node:os";

/** ADR 0009: the layer's own CPU per steady frame, at the 95th percentile, in ms. */
export const STEADY_P95_MS = 1.5;

/**
 * Asserts the render budget on the layer's own CPU per frame (the renderer's prepare time), not on the wall time of `render`, which under
 * software GL includes rasterising inside the GL calls and moves with the host. When the host is loaded (more than half a runnable
 * thread per cpu) the figure is recorded as a test annotation and not asserted, so a busy machine cannot fail the spec.
 */
export function steadyCpuWithinBudget(p95: number, what: string): void {
  const loadPerCpu = loadavg()[0]! / cpus().length;
  if (loadPerCpu <= 0.5) expect(p95, what).toBeLessThanOrEqual(STEADY_P95_MS);
  else test.info().annotations.push({ type: "recorded, not asserted", description: `${what}: ${p95} ms at host load ${loadPerCpu.toFixed(2)} per cpu` });
}
