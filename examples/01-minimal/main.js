// Loads the packed package from /pkg, builds a layer (no request, no worker, no GL context), then
// acquires the WASM evaluator under the page's CSP. Nothing here leaves the local server.
import { createPVecLayer } from "/pkg/index.js";
import { chooseTransport, loadEvaluator } from "/pkg/wasm.js";

const result = { errors: [], transport: chooseTransport(), crossOriginIsolated: self.crossOriginIsolated === true };
try {
  const layer = createPVecLayer({ id: "drawing", source: { url: new URL("/fixtures/small.pvec", location.href).href } });
  result.layerId = layer.id;
  const ev = await loadEvaluator({ wasmUrl: new URLSearchParams(location.search).get("wasmUrl") ?? undefined });
  result.wasm = { abi: ev.abiVersion, source: ev.source };
} catch (e) {
  result.errors.push({ code: e.code ?? e.name, message: String(e.message) });
}
window.__result = result;
const status = document.getElementById("status");
status.dataset.state = result.errors.length ? "error" : "ready";
status.textContent = result.errors.length ? `failed: ${result.errors[0].code}` : "ready";
document.getElementById("out").textContent = JSON.stringify(result, null, 2);
