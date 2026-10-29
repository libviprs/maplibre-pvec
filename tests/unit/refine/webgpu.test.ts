import { budget } from '../helpers/budget';
import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { selectTessellationBackend } from '../../../src/refine/backend';

const diagnostics = () => {
  const seen: { code: string; reason?: string }[] = [];
  return { seen, report: (d: { code: string; reason?: string }) => seen.push(d) };
};
const load = () => import('../../../src/experimental/webgpu');

describe('M6.7 flag off by default', () => {
  it('never reads navigator.gpu and never loads the experimental module', async () => {
    let touched = 0, loaded = 0;
    const nav = { get gpu() { touched++; return undefined; } } as { gpu?: unknown };
    const d = diagnostics();
    const b = await selectTessellationBackend({}, d.report, { nav, load: async () => { loaded++; return load(); } });
    expect(b.kind).toBe('wasm-worker');
    expect(touched).toBe(0);
    expect(loaded).toBe(0);
    expect(d.seen).toEqual([]);
  });
});

describe('M6.7 flag on without WebGPU', () => {
  it('falls back to the worker path and reports webgpuUnavailable exactly once', async () => {
    const d = diagnostics();
    const opts = { experimental: { webgpu: true } };
    for (let i = 0; i < 3; i++) expect((await selectTessellationBackend(opts, d.report, { nav: {}, load })).kind).toBe('wasm-worker');
    expect(d.seen.filter((x) => x.code === 'webgpuUnavailable')).toHaveLength(1);
  });
  it('a present API with no adapter is unavailable too', async () => {
    const d = diagnostics();
    const nav = { gpu: { requestAdapter: async () => null } };
    expect((await selectTessellationBackend({ experimental: { webgpu: true } }, d.report, { nav, load })).kind).toBe('wasm-worker');
    expect(d.seen[0]).toMatchObject({ code: 'webgpuUnavailable', reason: 'no-adapter' });
  });
  it('an adapter without a built kernel still falls back, with its own reason', async () => {
    const d = diagnostics();
    const nav = { gpu: { requestAdapter: async () => ({}) } };
    expect((await selectTessellationBackend({ experimental: { webgpu: true } }, d.report, { nav, load })).kind).toBe('wasm-worker');
    expect(d.seen[0]).toMatchObject({ reason: 'kernel-not-built' });
  });
});

describe('M6.7 default bundle', () => {
  it('has no WebGPU symbol, and the experimental code is a separate chunk', async () => {
    const out = mkdtempSync(join(tmpdir(), 'mlp-bundle-'));
    await build({
      entryPoints: [resolve('src/refine/backend.ts')], bundle: true, splitting: true, format: 'esm', outdir: out,
      platform: 'browser', minify: false, treeShaking: true, logLevel: 'silent',
    });
    const entry = readFileSync(join(out, 'backend.js'), 'utf8');
    for (const sym of ['navigator.gpu', 'requestAdapter', 'GPUDevice', 'webgpuUnavailable']) expect(entry.includes(sym), sym).toBe(false);
    const chunks = readdirSync(out).filter((f) => f !== 'backend.js');
    expect(chunks.length).toBeGreaterThan(budget(0));
    expect(chunks.map((f) => readFileSync(join(out, f), 'utf8')).join('\n')).toContain('webgpuUnavailable');
  });
});

describe('M6.7 no gate depends on it', () => {
  it('no required job in the local gate or workflows mentions WebGPU', () => {
    const files = ['tools/gate.sh'];
    const wf = '.github/workflows';
    if (existsSync(wf)) for (const f of readdirSync(wf)) files.push(join(wf, f));
    for (const f of files) expect(readFileSync(f, 'utf8').toLowerCase(), f).not.toContain('webgpu');
  });
  it('the ADR numbers its promotion criteria and names the tolerance policy', () => {
    const adr = readFileSync('docs/adr/webgpu-deferral.md', 'utf8');
    for (const n of [1, 2, 3, 4]) expect(adr).toMatch(new RegExp(`^${n}\\. `, 'm'));
    expect(adr).toMatch(/P1\.2/);
  });
});
