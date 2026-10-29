import { defineConfig } from "@playwright/test";

// Four conformance jobs, each reported on its own (tools/run-jobs.sh, tools/check-jobs.mjs).
// Specs are named with the issue number they cover. Always launch through
// /Users/rom/workspace/xdg-pw-lock.sh. The fixture origin is started by webServer and stopped by
// Playwright when the run ends, including after a failure; it listens on loopback only.
const jobs = ["math", "range", "rendering", "interaction"];
const browsers = ["chromium", "firefox"] as const;

export default defineConfig({
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { headless: true, baseURL: "http://127.0.0.1:4173" },
  webServer: {
    command: "node tools/fixture-origin.mjs",
    url: "http://127.0.0.1:4173/app/index.html",
    reuseExistingServer: false,
  },
  projects: jobs.flatMap((job) =>
    browsers.map((browserName) => ({
      name: `${job}-${browserName}`,
      testDir: `tests/e2e/${job}`,
      use: { browserName },
    })),
  ),
});
