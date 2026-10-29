// Loads the packed package from /pkg, acquires the WASM evaluator under the page's CSP, then
// opens the fixture's header, manifest and directory. Nothing here leaves the local server.
import { PVecSource } from "/pkg/index.js";
import { chooseTransport, loadEvaluator } from "/pkg/wasm.js";

const result = { errors: [], transport: chooseTransport(), crossOriginIsolated: self.crossOriginIsolated === true };
try {
  const ev = await loadEvaluator({ wasmUrl: new URLSearchParams(location.search).get("wasmUrl") ?? undefined });
  result.wasm = { abi: ev.abiVersion, source: ev.source };
  const source = new PVecSource({ url: new URL("/fixtures/small.pvec", location.href).href });
  const handle = await source.bootstrap();
  result.artifactLength = handle.artifactLength;
  result.chunks = source.queryBounds({ minX: 0, minY: 0, maxX: 1000, maxY: 1000 }).length;
} catch (e) {
  result.errors.push({ code: e.code ?? e.name, message: String(e.message) });
}
window.__result = result;
const status = document.getElementById("status");
status.dataset.state = result.errors.length ? "error" : "ok";
status.textContent = result.errors.length ? `failed: ${result.errors[0].code}` : "ready";
document.getElementById("out").textContent = JSON.stringify(result, null, 2);
