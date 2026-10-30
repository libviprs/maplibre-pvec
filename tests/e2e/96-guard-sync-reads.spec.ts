import { expect, test } from "@playwright/test";
import { H, launch, rig } from "./harness/layer-run";

// Issue 96: the state guard reads the GL state back every frame. In Chromium each getParameter is a round trip to the GPU
// process, and the first one waits for everything the previous frame queued, so a loaded GPU turns it into milliseconds of main
// thread time (10 ms a frame on an Apple M5 with 1e6 segments). The count is what is asserted here, because SwiftShader has no
// queue to wait on: a frame that is not being diffed must not read GL state back at all.
test.use({ launchOptions: launch });

test.describe("issue 96 state guard reads", () => {
  test("a frame with the debug diff off issues no synchronous GL reads", async ({ page }) => {
    const r = await rig(page);
    try {
      await H(page, "openStandalone", { fixture: r.url, debug: false });
      await H(page, "frameStandalone", "warm");
      const c = await H<{ frames: number; getParameter: number; isEnabled: number }>(page, "countReads", 10);
      expect(c.getParameter, "getParameter calls over 10 frames").toBe(0);
      expect(c.isEnabled, "isEnabled calls over 10 frames").toBe(0);
      const strokes = await H<{ red: number }>(page, "frameStandalone", "after");
      expect(strokes.red, "the strokes are still drawn").toBeGreaterThan(300);
    } finally {
      await r.stop();
    }
  });
});
