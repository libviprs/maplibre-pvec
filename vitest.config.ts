import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    // The default evaluator loader fetches pvec_eval.wasm next to the bundle; unit tests have no bundle.
    setupFiles: ["tests/unit/setup-engine.ts"],
    // Several suites assert wall-clock budgets; running files side by side makes those flaky.
    fileParallelism: false,
  },
});
