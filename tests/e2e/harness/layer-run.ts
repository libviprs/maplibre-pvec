import type { Page } from "@playwright/test";
import { buildSync } from "esbuild";
import { resolve } from "node:path";
import { RangeOrigin } from "../../unit/helpers/origin";
import { buildPvec, gridSpec } from "../../unit/helpers/fixture";

const bundle = buildSync({
  entryPoints: [resolve("tests/e2e/harness/layer-entry.ts")],
  bundle: true,
  format: "iife",
  globalName: "H",
  write: false,
  define: { "import.meta.url": "location.href" },
  logLevel: "silent",
}).outputFiles[0]!.text;

/** The issue asks for a match within 0.1 percent of the pixels. A display measurement, not a mathematical tolerance. */
export const SNAPSHOT_MATCH = 0.001;
export const launch = { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] };

export interface Rig { origin: RangeOrigin; url: string; stop(): Promise<void>; gets(): number }

/** A loopback range origin serving the fixture, and the page with the bundle loaded. */
export async function rig(page: Page): Promise<Rig> {
  const origin = new RangeOrigin(buildPvec(gridSpec()).bytes);
  const base = await origin.start();
  await page.goto("/app/index.html");
  await page.addScriptTag({ content: bundle });
  return { origin, url: `${base}/p.pvec`, stop: () => origin.stop(), gets: () => origin.log.filter((l) => l.method === "GET").length };
}

/** Calls window.H.<fn>(arg) in the page. */
export const H = <T>(page: Page, fn: keyof Api, arg?: unknown): Promise<T> =>
  page.evaluate(([f, a]) => (window as unknown as { H: Record<string, (x: unknown) => unknown> }).H[f as string]!(a), [fn, arg] as const) as Promise<T>;
type Api = typeof import("./layer-entry");
