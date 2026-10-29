import { defineConfig } from "@playwright/test";

// Specs live in tests/e2e and are named with the issue number they reproduce
// or cover. Always launch through /Users/rom/workspace/xdg-pw-lock.sh.
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { headless: true },
});
