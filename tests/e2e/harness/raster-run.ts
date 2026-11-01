import type { Page } from "@playwright/test";
import { buildSync } from "esbuild";
import { resolve } from "node:path";
import { RangeOrigin } from "../../unit/helpers/origin";
import { buildPvec, gridSpec } from "../../unit/helpers/fixture";

const bundle = buildSync({
  entryPoints: [resolve("tests/e2e/harness/raster-entry.ts")],
  bundle: true,
  format: "iife",
  globalName: "RH",
  write: false,
  define: { "import.meta.url": "location.href" },
  logLevel: "silent",
}).outputFiles[0]!.text;

/** A loopback range origin serving a small container (the layer still bootstraps a real file), and the page with the bundle loaded. */
export async function rasterRig(page: Page) {
  const origin = new RangeOrigin(buildPvec(gridSpec()).bytes);
  const base = await origin.start();
  await page.goto("/app/index.html");
  await page.addScriptTag({ content: `window.__FIXTURE__ = ${JSON.stringify(`${base}/p.pvec`)};` });
  await page.addScriptTag({ content: bundle });
  return { origin, stop: () => origin.stop() };
}

/** Calls window.RH.<fn>(arg) in the page. */
export const R = <T>(page: Page, fn: keyof Api, arg?: unknown): Promise<T> =>
  page.evaluate(([f, a]) => (window as unknown as { RH: Record<string, (x: unknown) => unknown> }).RH[f as string]!(a), [fn, arg] as const) as Promise<T>;
type Api = typeof import("./raster-entry");
