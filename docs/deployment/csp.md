# Deployment: WASM acquisition and CSP

The geometry evaluator is the shared PVec Rust code compiled to WASM, so a deployment has to let the page fetch and compile one `.wasm` file. Nothing else here needs relaxing.

## The policy that works

```text
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'
```

- `'wasm-unsafe-eval'` is the only relaxation. It allows `WebAssembly.compile` and `instantiate`, and nothing else: no `eval`, no `new Function`, no `'unsafe-eval'`.
- The package never uses `eval`, never injects an inline script and never creates a `blob:` script. It runs under `script-src 'self'` plus the one keyword above.
- It never needs COOP or COEP headers. Shared memory is used only when `crossOriginIsolated` is true, otherwise buffers are transferred.

I checked this with `examples/01-minimal` (`tools/examples.sh`): under exactly the policy above the example loads the evaluator and opens the fixture, and under the same policy without `'wasm-unsafe-eval'` it fails with `wasm_unavailable`.

## Three ways to get the module

| mode | option | use it when |
|---|---|---|
| default | none | the asset sits next to the JS, same origin. The URL is `new URL("./pvec_eval.wasm", import.meta.url)`, which bundlers that understand that pattern also rewrite |
| explicit | `wasmUrl` | CDN or hashed-asset deployments. Add the CDN origin to `connect-src` (or `default-src`) |
| injected | `wasmModule` or `instantiate` | the host compiles the module itself (a build step, a service worker, a policy that forbids the page to fetch). The package then never calls `fetch` |

The package also exports the asset as `maplibre-pvec/wasm/pvec_eval.wasm`, so a bundler can resolve it by name.

## Subresource integrity

`<link rel="modulepreload" integrity="sha384-...">` covers the JS. For the `.wasm`, fetch it yourself with `integrity` set and hand the result in through `instantiate`, or serve it from a content-hashed URL and pass `wasmUrl`. The package does not hash anything at runtime.

## When the fetch or compile is blocked

`loadEvaluator` rejects with a `PVecError` whose `code` is `wasm_unavailable`. The message says why (CSP, a non-2xx status, a compile error, a module without `pvec_abi_version`). There is no TypeScript geometry fallback: geometry semantics come from the shared evaluator or not at all. When the custom layer exists, `onAdd` surfaces this as a rejection and one `error` event, and MapLibre's own layers keep rendering (see `docs/deferred.md`, issue 31, for what is still missing there).

A response with the wrong `Content-Type` is not an error: it falls back to compiling the bytes.
