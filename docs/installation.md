# Installation

The package is not published. It is `private` in `package.json` and carries version `0.0.0` until the v1 gate in `release/v1-gate.json` is green (see [v1 readiness](v1-readiness.md)). Today you build and pack it from a checkout:

```text
npm ci
npm run build
npm pack
```

`tools/pack.sh` does the same in a throw-away container and runs the pack check (publint, are-the-types-wrong, entry resolution) without publishing anything.

## Shape of the package

| entry | what |
|---|---|
| `maplibre-pvec` | `createPVecLayer`, `PVecLayer`, the typed errors and the option and event types |
| `maplibre-pvec/style` | optional style resolver registration |
| `maplibre-pvec/text` | optional text renderer registration |
| `maplibre-pvec/hatch` | optional hatch renderer registration |
| `maplibre-pvec/wasm` | `loadEvaluator` |
| `maplibre-pvec/wasm/pvec_eval.wasm` | the evaluator asset |

## Requirements

- `maplibre-gl` as a peer, `>=4.7.1 <7.0.0`. The tested rows are in [compatibility](compatibility.md).
- A browser with WebGL2 and module workers. There is no canvas fallback. Tested minimums are Chromium 111, Firefox 131 and WebKit 18.0 (see [compatibility](compatibility.md)); Firefox needs a display (or a software GL stack) to get WebGL2 in a headless container.
- A way to let the page fetch and compile one `.wasm` file, see [WASM, worker and CSP deployment](wasm-worker-deployment.md).
- An origin that answers `Range` requests with a stable `ETag` or version.

## Minimal use

```js
import { createPVecLayer } from "maplibre-pvec";

const layer = createPVecLayer({
  id: "plan",
  source: { url: "http://localhost:8080/plan.pvec" },
});
map.addLayer(layer);
await layer.whenReady();
```

The evaluator is a real PVec WASM build only once `libviprs/pvec` releases one; see [deferred work](deferred.md).

## Where the evaluator module comes from (building the package)

`wasm/pvec_eval.wasm` is committed and pinned by `wasm/pvec.pin.json`; `tools/pvec-artifacts.sh` rebuilds it from the pinned `libviprs/pvec` commit in a container. That stays the fallback.

When `libviprs/pvec` has a staged release directory (`tools/wasm-release.sh` there: the module, `pvec-wasm-manifest.json` and `SHA256SUMS`), two switches take it instead:

- `PVEC_WASM=<dir or .wasm> npm run build` copies that module into `dist/`. With a manifest beside it, the sha256 and the ABI version are checked first and the build fails on a mismatch. `PVEC_WASM_SHA256=<hex>` also requires one digest. A bare `.wasm` with no manifest is still accepted as an unverified local build.
- `PVEC_RELEASE=<dir> PVEC_SRC=<pvec checkout> tools/pvec-artifacts.sh` does the same verification, skips the wasm build, and records the release commit under `release` in the pin. The fixtures still come from the pinned commit.
