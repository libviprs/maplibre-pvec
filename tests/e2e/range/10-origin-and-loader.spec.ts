import { expect, test } from "@playwright/test";

test.describe("#10 hermetic origin and shared loader", () => {
  test("serves byte ranges with the CORS and Range headers a browser needs", async ({ page, browser, browserName }) => {
    console.log(`engine: ${browserName} ${browser.version()} on ${process.platform}/${process.arch}`);
    await page.goto("/app/index.html");
    const r = await page.evaluate(async () => {
      const whole = await fetch("/corpus/r0-open/manifest.json");
      const size = (await whole.arrayBuffer()).byteLength;
      const part = await fetch("/corpus/r0-open/manifest.json", { headers: { Range: "bytes=0-9" } });
      const bad = await fetch("/corpus/r0-open/manifest.json", { headers: { Range: "bytes=99999999-" } });
      return {
        size,
        status: part.status,
        range: part.headers.get("content-range"),
        len: (await part.arrayBuffer()).byteLength,
        bad: bad.status,
      };
    });
    expect(r.status).toBe(206);
    expect(r.range).toBe(`bytes 0-9/${r.size}`);
    expect(r.len).toBe(10);
    expect(r.bad).toBe(416);
  });

  test("the registry the Vitest suites use verifies the corpus in the page", async ({ page }) => {
    await page.goto("/app/index.html");
    const r = await page.evaluate(() => window.corpus("/corpus"));
    console.log(r.summary);
    expect(r.error).toBeUndefined();
    expect(r.fixtures).toBe(30);
    expect(r.summary).toContain("corpus revision: r0-open");
  });

  test("a deliberately corrupted artifact turns the in-page loader red", async ({ page }) => {
    await page.goto("/app/index.html");
    const r = await page.evaluate(() => window.corpus("/corrupt/corpus"));
    expect(r.error).toBe("CorpusVerificationError");
    expect(r.fixtures).toBe(0);
  });

  test("the page talks to the local origin only", async ({ page }) => {
    const hosts = new Set<string>();
    page.on("request", (q) => hosts.add(new URL(q.url()).host));
    await page.goto("/app/index.html");
    await page.evaluate(() => window.corpus("/corpus"));
    expect([...hosts]).toEqual(["127.0.0.1:4173"]);
  });
});
