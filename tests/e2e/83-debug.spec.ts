import { test } from "@playwright/test";
import { H, launch, rig } from "./harness/layer-run";
test.use({ launchOptions: launch });
test("debug: plain canvas and plain map restore", async ({ page }) => {
  const r = await rig(page);
  const bare = await page.evaluate(async () => {
    const c = document.createElement("canvas"); document.body.appendChild(c);
    const gl = c.getContext("webgl2")!; const ext = gl.getExtension("WEBGL_lose_context")!;
    c.addEventListener("webglcontextlost", (e) => e.preventDefault());
    const out: string[] = [];
    const lost = new Promise<void>((res) => c.addEventListener("webglcontextlost", () => res(), { once: true }));
    const rest = new Promise<void>((res) => c.addEventListener("webglcontextrestored", () => res(), { once: true }));
    ext.loseContext(); await lost; out.push("lost");
    ext.restoreContext();
    await Promise.race([rest.then(() => out.push("restored")), new Promise((res) => setTimeout(res, 4000))]);
    out.push(String(gl.isContextLost()));
    return out;
  });
  console.log("DEBUG bare", JSON.stringify(bare));
  for (const layer of [false, true]) {
    await H(page, "open", { fixture: r.url, layer, cursor: true, wasm: "ok" });
    const res = await H(page, "loseAndRestore").then((x) => JSON.stringify(x), (e) => String(e));
    console.log("DEBUG map layer=" + layer, res);
  }
  await r.stop();
});
