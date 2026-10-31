import { defineConfig } from "@playwright/test";

// Four conformance jobs, each reported on its own (tools/run-jobs.sh, tools/check-jobs.mjs).
// Specs are named with the issue number they cover. Always launch through
// /Users/rom/workspace/xdg-pw-lock.sh. The fixture origin is started by webServer and stopped by
// Playwright when the run ends, including after a failure; it listens on loopback only.
const jobs = ["math", "range", "rendering", "interaction"];
const browsers = ["chromium", "firefox", "webkit"] as const;
// Software GL for Chromium (ANGLE on SwiftShader). Firefox gets WebGL2 from the X display that xvfb-run
// provides in tools/run-grid.sh, WebKit has its own software path.
const chromiumGl = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
// The browser grid (#81): one project per engine, plus an older Chromium when PW_CHROMIUM_MIN names a
// binary, plus the informational COOP/COEP run against the isolated origin on 4174.
const gridUse = (browserName: (typeof browsers)[number]) => ({ browserName, launchOptions: browserName === "chromium" ? { args: chromiumGl } : {} });
const minChromium = process.env.PW_CHROMIUM_MIN;

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
  projects: [
    ...browsers.map((b) => ({ name: `grid-${b}`, testDir: "tests/e2e", testMatch: ["grid/81-grid.spec.ts"], use: gridUse(b) })),
    ...(minChromium
      ? [{ name: "grid-chromium-min", testDir: "tests/e2e", testMatch: ["grid/81-grid.spec.ts"], use: { browserName: "chromium" as const, launchOptions: { executablePath: minChromium, args: chromiumGl } } }]
      : []),
    ...browsers.map((b) => ({ name: `isolated-${b}`, testDir: "tests/e2e", testMatch: ["grid/81-isolated.spec.ts"], use: { ...gridUse(b), baseURL: "http://127.0.0.1:4174" } })),
    ...jobs.flatMap((job) =>
    browsers.map((browserName) => ({
      name: `${job}-${browserName}`,
      testDir: "tests/e2e",
      // The Tier 0 stroke pipeline spec from #50 sits at the top of tests/e2e and is a rendering spec.
      // It sets Chromium-only SwiftShader launch flags, so it runs on Chromium alone. The 83-* specs (wired layer
      // on a real MapLibre map) are the same kind.
      testMatch: job === "rendering" && browserName === "chromium" ? [`${job}/**/*.spec.ts`, "50-*.spec.ts", "83-*.spec.ts", "96-*.spec.ts", "102-*.spec.ts"] : [`${job}/**/*.spec.ts`],
      use: { browserName },
    })),
  ),
  ],
});
