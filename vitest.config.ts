import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    // Several suites assert wall-clock budgets; running files side by side makes those flaky.
    fileParallelism: false,
  },
});
