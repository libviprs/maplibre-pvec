import type { Page } from "@playwright/test";
import { buildSync } from "esbuild";
import { resolve } from "node:path";
import { RangeOrigin } from "../../unit/helpers/origin";
import { buildPvec, gridSpec } from "../../unit/helpers/fixture";

const bundle = buildSync({
  entryPoints: [resolve("tests/e2e/harness/compose-entry.ts")],
  bundle: true,
  format: "iife",
  globalName: "CH",
  write: false,
  define: { "import.meta.url": "location.href" },
  logLevel: "silent",
}).outputFiles[0]!.text;

/** A loopback range origin serving a small container, and a page with the compose bundle loaded. MapLibre itself is loaded by `open`. */
export async function composeRig(page: Page) {
  const origin = new RangeOrigin(buildPvec(gridSpec()).bytes);
  const base = await origin.start();
  await page.goto("/app/grid.html");
  await page.addScriptTag({ content: `window.__FIXTURE__ = ${JSON.stringify(`${base}/p.pvec`)};` });
  await page.addScriptTag({ content: bundle });
  return { origin, gets: () => origin.log.filter((l) => l.method === "GET").length, stop: () => origin.stop() };
}

/** Calls window.CH.<fn>(arg) in the page. */
export const C = <T>(page: Page, fn: keyof Api, arg?: unknown): Promise<T> =>
  page.evaluate(([f, a]) => (window as unknown as { CH: Record<string, (x: unknown) => unknown> }).CH[f as string]!(a), [fn, arg] as const) as Promise<T>;
type Api = typeof import("./compose-entry");
