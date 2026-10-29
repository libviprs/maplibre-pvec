// Bundled for the page by tools/fixture-origin.mjs: the same registry the Vitest suites use.
import { loadRegistry, runSummary } from "./registry";
import { httpSource, type CorpusPin } from "./source";

declare global {
  interface Window {
    corpus: (path: string) => Promise<{ summary: string; fixtures: number; error?: string }>;
  }
}

window.corpus = async (prefix: string) => {
  const pin = (await (await fetch("/app/pin.json")).json()) as CorpusPin;
  try {
    const reg = await loadRegistry(httpSource(`${location.origin}${prefix}`), pin);
    return { summary: runSummary(reg), fixtures: reg.fixtures.length };
  } catch (e) {
    return { summary: "", fixtures: 0, error: (e as Error).name };
  }
};
