import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';
import { resolve } from 'node:path';

// Real WebGL2 through software rasterisation (SwiftShader). Run via /Users/rom/workspace/xdg-pw-lock.sh.
const bundle = buildSync({ entryPoints: [resolve('tests/e2e/harness/entry.ts')], bundle: true, format: 'iife', globalName: 'H', write: false }).outputFiles[0]!.text;

type R = { w: number; h: number; alpha: number[]; glError: number; stateDiffs: string[]; dpr: number; renderer: string };

test.use({ launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } });

for (const dpr of [1, 2]) {
  test.describe(`issue 50 stroke pipeline, devicePixelRatio ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });

    const run = async (page: import('@playwright/test').Page, scene: unknown): Promise<R> => {
      await page.setContent('<html><body></body></html>');
      await page.addScriptTag({ content: bundle });
      return page.evaluate((s) => (window as unknown as { H: { render(s: unknown): R } }).H.render(s), scene);
    };
    const sum = (r: R) => r.alpha.reduce((a, b) => a + b, 0) / 255;

    for (const deg of [0, 22.5, 45]) {
      test(`4 css px line measures 4 +/- 0.5 px at bearing ${deg}`, async ({ page }) => {
        const a = (deg * Math.PI) / 180, L = 120, c = 100;
        const r = await run(page, { size: 200, lines: [{ points: [c - (L / 2) * Math.cos(a), c - (L / 2) * Math.sin(a), c + (L / 2) * Math.cos(a), c + (L / 2) * Math.sin(a)], widthCss: 4 }] });
        expect(r.glError).toBe(0);
        expect(r.stateDiffs).toEqual([]);
        // butt caps: coverage area / length is the width, bearing independent
        const widthCss = sum(r) / (L * dpr) / dpr;
        expect(Math.abs(widthCss - 4)).toBeLessThanOrEqual(0.5);
      });
    }

    test('antialias symmetry: both directions give identical pixels', async ({ page }) => {
      const p = [20.3, 30.7, 150.2, 110.9];
      const a = await run(page, { size: 200, lines: [{ points: p, widthCss: 3 }] });
      const b = await run(page, { size: 200, lines: [{ points: [p[2], p[3], p[0], p[1]], widthCss: 3 }] });
      let diff = 0;
      for (let i = 0; i < a.alpha.length; i++) if (a.alpha[i] !== b.alpha[i]) diff++;
      expect(diff).toBe(0);
    });

    test('dash phase is continuous across 100 segments (<= 0.2 percent differing pixels)', async ({ page }) => {
      const pts: number[] = []; for (let i = 0; i <= 100; i++) pts.push(10 + i * 1.6, 50);
      const many = await run(page, { size: 200, lines: [{ points: pts, widthCss: 4, dash: [8, 4] }] });
      const one = await run(page, { size: 200, lines: [{ points: [10, 50, 10 + 160, 50], widthCss: 4, dash: [8, 4] }] });
      let diff = 0;
      for (let i = 0; i < one.alpha.length; i++) if (Math.abs(one.alpha[i]! - many.alpha[i]!) > 8) diff++;
      expect(diff / one.alpha.length).toBeLessThanOrEqual(0.002);
      expect(sum(one)).toBeGreaterThan(0);
    });

    test('miter join fills the outer corner, bevel does not', async ({ page }) => {
      const corner = [40, 150, 40, 40, 150, 40];
      const mitered = await run(page, { size: 200, lines: [{ points: corner, widthCss: 20 }] });
      const bevel = await run(page, { size: 200, lines: [{ points: corner, widthCss: 20, flags: 1 << 4 }] });
      const at = (r: R, x: number, y: number) => r.alpha[Math.round(y * dpr) * r.w + Math.round(x * dpr)]!;
      expect(at(mitered, 32, 32)).toBeGreaterThan(200);
      expect(at(bevel, 32, 32)).toBeLessThan(10);
    });
  });
}
