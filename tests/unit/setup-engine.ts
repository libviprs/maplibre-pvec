import { setEngineDefaults } from "../../src/layer/internal";

// Unit tests run in node, where there is no bundle to load pvec_eval.wasm from. The wasm loader has its own
// tests (tests/unit/compat/wasm.test.ts) and the wired layer tests inject loaders per layer.
setEngineDefaults({ loadEvaluator: () => Promise.resolve({ instance: {} as WebAssembly.Instance, abiVersion: 1, source: "injected" }) });
