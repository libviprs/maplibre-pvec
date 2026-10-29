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
- A browser with WebGL2 and module workers. There is no canvas fallback. Firefox and WebKit rows are pending, so no minimum is claimed for them.
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
