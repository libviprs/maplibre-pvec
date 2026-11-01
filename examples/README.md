# Examples

Run them with `tools/examples.sh` from the repo root (through `/Users/rom/workspace/xdg-pw-lock.sh`). It copies the tree to the docker host and runs everything in a throw-away Playwright container: install, `npm run build`, `npm pack`, install that tarball into a clean directory, then each example against the tarball. Screenshots land in `examples/out/`, with one `summary.json` (the run record that `release/examples-run.json` is copied from and the release gate reads). Nothing runs on the machine you launch it from, and nothing needs the internet once the container has its dependencies.

Every example starts its own server (`examples/lib/serve.mjs`, bound to 127.0.0.1, closed on every path including a throw) and serves the packed package under `/pkg`, the page, and in-memory fixtures. No example uses a third-party endpoint, a demo tile service or an API key. `tests/unit/compat/examples.test.ts` checks that mechanically.

| example | state | fixture | expected end state |
|---|---|---|---|
| `01-minimal` | runs | `smallFixture()`, the 4 x 4 structural container | under `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'` a layer is built and the real evaluator loads (`abi` 1 or 2); without the WASM keyword, or with the `.wasm` request aborted, one `wasm_unavailable` error |
| `02-georeferenced` | runs | `scan_under_linework.pvec`, a 64 by 48 ramp painted 100 by 75 m by libviprs | the scan is drawn on a real MapLibre map where the page's calibration puts it: at a lattice of 48 screen points the pixel is the ramp at the source point under it (`lib/truth.mjs`, which does not touch the add-on), or the map background outside the sheet. Points near the sheet's edge or the stroke drawn across it are not compared |
| `03-refinement` | blocked | | needs the `refinement` events from a real stream: nothing in the layer drives the refiner against the module yet, and nothing calls `markTier0Complete` (#84) |
| `04-large-budget` | blocked | | needs a large raster `.pvec` (pvec has no tiler that writes one yet) and the refinement stream, to put a heap and GPU budget under load (#84) |
| `05-picking` | blocked | | `pickPoint` and `nearestEntity` need a query engine, nothing attaches one to the layer (`attachQuery` has no caller), and the pinned module exports no exact distance to a curve (#84) |
| `06-georeference-update` | runs | the same scan | after `layer.update({ georeference })` the scan is where the second calibration puts it at the same screen points, and the file is not requested again |
| `07-raster-underlay` | runs | libviprs's conversions of a scanned PDF (`tests/fixtures/pvec-raster/libviprs/scan_under_linework.pvec` and `scan_over_linework.pvec`, band 0 and band 1) and pvec's synthetic raster file (`synthetic.pvec`, the third raster has a codec the reader does not know) | band 0 puts the linework on top and band 1 the scan, the unknown codec is one `rasterskipped` with `RASTER-04`, the attribution is text in MapLibre's control, the toggle off paints less, and no origin other than 127.0.0.1 is asked for |

`examples/generate-large.mjs` builds the large synthetic container at run time (`node examples/generate-large.mjs 4096 16384`).

Using the package from your own bundler is the same minus the server: `import { createPVecLayer } from "maplibre-pvec"` and `import { loadEvaluator } from "maplibre-pvec/wasm"`. The examples import `/pkg/index.js` because an import map cannot be external and a page under a strict CSP cannot carry an inline one.

## Colours

`examples/01-minimal/style.css` is the only UI. Measured contrast (WCAG 2.x relative luminance):

| pair | light | dark |
|---|---|---|
| text on background | #111111 on #ffffff, 18.88:1 | #f2f2f2 on #111111, 16.87:1 |
| ready status | #0b5d1e on #ffffff, 8.08:1 | #7ee08f on #111111, 11.64:1 |
| failed status | #8f1d1d on #ffffff, 8.89:1 | #ff9c9c on #111111, 9.43:1 |
