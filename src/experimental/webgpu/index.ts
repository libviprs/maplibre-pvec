/**
 * Experimental WebGPU tessellation backend, behind `experimental.webgpu`. Loaded only through a
 * dynamic import from refine/backend.ts, so the default bundle carries none of it.
 *
 * What exists: availability probing and the `webgpuUnavailable` reason. What does not: the compute
 * kernel. A tessellation kernel is curve mathematics, which must come from PVec's evaluator, not
 * from a hand-written shader in this repository, and there is no GPU runner to measure on
 * (docs/deferred.md, docs/adr/webgpu-deferral.md). A present adapter therefore still reports
 * `kernel-not-built`, and rendering stays on the WebGL2 path.
 */
export type ProbeResult = { ok: true } | { ok: false; reason: string; diagnostic: { code: 'webgpuUnavailable'; reason: string } };

const no = (reason: string): ProbeResult => ({ ok: false, reason, diagnostic: { code: 'webgpuUnavailable', reason } });

export async function probeWebGpu(nav: { gpu?: unknown }): Promise<ProbeResult> {
  const gpu = nav.gpu as { requestAdapter?: () => Promise<unknown> } | undefined;
  if (!gpu || typeof gpu.requestAdapter !== 'function') return no('no-webgpu-api');
  let adapter: unknown;
  try {
    adapter = await gpu.requestAdapter();
  } catch {
    return no('adapter-request-failed');
  }
  if (!adapter) return no('no-adapter');
  return no('kernel-not-built');
}
