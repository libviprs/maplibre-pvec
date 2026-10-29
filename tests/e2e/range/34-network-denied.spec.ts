import { expect, test } from "@playwright/test";
import { denyExternal } from "../../../bench/lib/network";

test.describe("#34 the harness runs with outbound network denied", () => {
  test("a request to anything but the local origin is blocked and counted", async ({ page }) => {
    const denied = await denyExternal(page.context(), "127.0.0.1");
    await page.goto("/app/index.html");
    const r = await page.evaluate(async () => {
      const out: string[] = [];
      for (const u of ["http://example.com/x.json", "https://tile.openstreetmap.org/0/0/0.png", "http://192.0.2.1/a"]) {
        try {
          await fetch(u, { mode: "no-cors" });
          out.push("reached");
        } catch {
          out.push("blocked");
        }
      }
      const ok = await fetch("/corpus/r0-open/manifest.json");
      return { out, local: ok.status };
    });
    expect(r.out).toEqual(["blocked", "blocked", "blocked"]);
    expect(r.local).toBe(200);
    expect(denied.hosts().sort()).toEqual(["192.0.2.1", "example.com", "tile.openstreetmap.org"]);
  });
});
