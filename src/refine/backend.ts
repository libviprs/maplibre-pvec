export type BackendKind = 'wasm-worker' | 'webgpu';

export interface Diagnostic {
  code: string;
  reason?: string;
}

export interface BackendOptions {
  experimental?: { webgpu?: boolean };
}

interface WebGpuModule {
  probeWebGpu(nav: { gpu?: unknown }): Promise<{ ok: true } | { ok: false; reason: string; diagnostic: Diagnostic }>;
}

/**
 * Pick the tessellation backend. WebGL2 with the worker and WASM path is the baseline. The
 * experimental WebGPU module is loaded, and navigator.gpu touched, only when the flag is set; any
 * failure falls back to the baseline and is reported once.
 */
export async function selectTessellationBackend(
  options: BackendOptions,
  report: (d: Diagnostic) => void,
  deps: { nav?: { gpu?: unknown }; load?: () => Promise<WebGpuModule> } = {},
): Promise<{ kind: BackendKind }> {
  if (!options.experimental?.webgpu) return { kind: 'wasm-worker' };
  const load = deps.load ?? (() => import('../experimental/webgpu'));
  const mod = await load();
  const nav = deps.nav ?? (globalThis as { navigator?: { gpu?: unknown } }).navigator ?? {};
  const r = await mod.probeWebGpu(nav);
  if (!r.ok) {
    if (!reported.has(report)) {
      reported.add(report);
      report(r.diagnostic);
    }
    return { kind: 'wasm-worker' };
  }
  return { kind: 'webgpu' };
}

/** One report per sink: "reports the condition once in diagnostics". */
const reported = new WeakSet<(d: Diagnostic) => void>();
