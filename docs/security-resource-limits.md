# Security and resource limits

## Network

- Requests go only to the `url` in `PVecSourceOptions` (and, if the host sets it, the `wasmUrl`). The package makes no other request, uses no third-party endpoint and carries no key.
- Credentials are the host's business: `headers` for static values, `auth(request)` for a token or a signature per request. The package stores nothing and writes nothing to disk.
- The artifact's identity (ETag or version) is checked on every range. A change is an error, not a silent mix of two files.

## Code

- No `eval`, no `new Function`, no inline script and no `blob:` script. The only CSP relaxation is `'wasm-unsafe-eval'`, see [WASM, worker and CSP deployment](wasm-worker-deployment.md).
- Cross-origin isolation is never required.

## Resource limits

`ResourceLimits` caps what the browser may hold: `maxDecodedBytes`, `maxQueuedBytes` and `maxEntities`. `CacheBudget` caps each cache tier. Over a cap the layer refuses or sheds work and emits a typed error (`PVecBackpressureError`, `PVecCapabilityError`, `PVecFormatError`) instead of growing. A Tier 0 block with more than 200,000 entities is refused at decode.

Rasters add one more consumer: the browser's image decoder. No codec runs in this package, so the decoder's sandbox is the defence for pixels, with the module's sniffers in front of it (a tile that is also an archive, an animated WebP, an interlaced or 16-bit PNG, a CMYK JPEG is refused by rule before any bytes reach `createImageBitmap`). The caps mirror the module's: `limits.maxDecodedBytes` is LIMIT-16 on the host side, and a stored tile over LIMIT-15 is never read. A refusal is one `rasterskipped` event, not a hidden failure. The page for the subject is [rasters](raster.md).

Malformed input is a `PVecFormatError`. A required capability the build does not support is reported through `capabilityunsupported` and `unsupported_required_capability`, and the layer draws nothing for it.

Fuzzing of the container reader belongs to `libviprs/pvec`; the browser side validates what it decodes. The reader hardening runs against real bytes are in [deferred work](deferred.md).
