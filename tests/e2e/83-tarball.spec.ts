import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RangeOrigin } from "../unit/helpers/origin";
import { buildPvec, gridSpec } from "../unit/helpers/fixture";
import { launch } from "./harness/layer-run";

// Issue 83: install the packed tarball into a clean project and render a fixture in a headless browser.
// Run via /Users/rom/workspace/xdg-pw-lock.sh. The browser only talks to loopback servers.
test.use({ launchOptions: launch });
test.setTimeout(300_000);

let app = "";
test.beforeAll(() => {
  const run = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
  const here = process.cwd();
  run("npm", ["run", "build"], here);
  const pack = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", mkdtempSync(join(tmpdir(), "pvec-pack-"))], here)) as { filename: string }[];
  const tgz = join(pack[0]!.filename.startsWith("/") ? "" : "", pack[0]!.filename);
  app = mkdtempSync(join(tmpdir(), "pvec-app-"));
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "consumer", private: true, version: "0.0.0" }));
  const dir = tgz.startsWith("/") ? tgz : join(tmpdir(), tgz);
  run("npm", ["install", "--no-audit", "--no-fund", "--no-save", dir, "maplibre-gl@4.7.1"], app);
});

const MIME: Record<string, string> = { ".js": "text/javascript", ".wasm": "application/wasm", ".html": "text/html", ".css": "text/css" };

function serve(blockWasm: boolean): Promise<{ server: Server; base: string; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.push(url.pathname);
    const file =
      url.pathname === "/page.html" ? undefined
      : url.pathname.startsWith("/pkg/") ? join(app, "node_modules/maplibre-pvec/dist", url.pathname.slice(5))
      : url.pathname === "/maplibre.js" ? join(app, "node_modules/maplibre-gl/dist/maplibre-gl.js")
      : undefined;
    if (url.pathname === "/page.html") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(PAGE);
    }
    if (!file || (blockWasm && url.pathname.endsWith(".wasm"))) {
      res.writeHead(404);
      return res.end("no");
    }
    try {
      const ext = file.slice(file.lastIndexOf("."));
      res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404);
      res.end("no");
    }
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits })));
}

const PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0"><div id="m" style="width:256px;height:256px"></div>
<script src="/maplibre.js"></script>
<script type="module">
import { createPVecLayer } from "/pkg/index.js";
const q = new URLSearchParams(location.search);
const map = new maplibregl.Map({ container: "m", center: [0, 0], zoom: 3, interactive: false, fadeDuration: 0, attributionControl: false, preserveDrawingBuffer: true,
  style: { version: 8, sources: { l: { type: "geojson", data: { type: "Feature", geometry: { type: "LineString", coordinates: [[-20, 0], [20, 0]] } } } },
    layers: [{ id: "bg", type: "background", paint: { "background-color": "#dfe7ee" } }, { id: "l", type: "line", source: "l", paint: { "line-color": "#112233", "line-width": 8 } }] } });
await new Promise((r) => map.once("load", r));
const layer = createPVecLayer({ id: "pvec", source: { url: q.get("fixture") } });
const errors = [];
layer.on("error", (e) => errors.push(e.code));
map.addLayer(layer);
await layer.whenReady();
await new Promise((r) => { map.triggerRepaint(); map.once("idle", r); });
const c = document.createElement("canvas"); c.width = map.getCanvas().width; c.height = map.getCanvas().height;
const x = c.getContext("2d"); x.drawImage(map.getCanvas(), 0, 0);
const px = (a, b) => Array.from(x.getImageData(a, b, 1, 1).data);
const mid = Math.floor(c.height / 2), dpr = c.width / 256;
window.__result = { errors, diag: layer.getDiagnostics(), corner: px(2, 2), line: px(Math.floor(c.width / 2), mid), version: maplibregl.getVersion(), dpr };
document.title = "done";
</script>`;

test.describe("issue 83 the installed tarball on a real map", () => {
  test("adds the layer, opens the container and leaves MapLibre's layers rendering", async ({ page }) => {
    const origin = new RangeOrigin(buildPvec(gridSpec()).bytes);
    const fx = await origin.start();
    const s = await serve(false);
    try {
      const outbound = new Set<string>();
      page.on("request", (q) => outbound.add(new URL(q.url()).host));
      await page.goto(`${s.base}/page.html?fixture=${encodeURIComponent(`${fx}/p.pvec`)}`);
      await page.waitForFunction("document.title === 'done'", undefined, { timeout: 60_000 });
      const r = (await page.evaluate("window.__result")) as { errors: string[]; diag: { ranges: { issued: number }; frames: number }; corner: number[]; line: number[] };
      expect(r.errors).toEqual([]);
      expect(r.diag.ranges.issued).toBeGreaterThan(0);
      expect(r.diag.frames).toBeGreaterThan(0);
      expect(r.corner.slice(0, 3)).toEqual([0xdf, 0xe7, 0xee]);
      expect(r.line.slice(0, 3)).toEqual([0x11, 0x22, 0x33]);
      expect(origin.log.filter((l) => l.method === "GET").length).toBeGreaterThan(0);
      expect([...outbound].every((h) => h.startsWith("127.0.0.1:"))).toBe(true);
    } finally {
      s.server.close();
      await origin.stop();
    }
  });

  test("with the evaluator blocked the installed layer reports wasm_unavailable once, requests nothing, and MapLibre still renders", async ({ page }) => {
    const origin = new RangeOrigin(buildPvec(gridSpec()).bytes);
    const fx = await origin.start();
    const s = await serve(true);
    try {
      await page.goto(`${s.base}/page.html?fixture=${encodeURIComponent(`${fx}/p.pvec`)}`);
      await page.waitForFunction("document.title === 'done'", undefined, { timeout: 60_000 });
      const r = (await page.evaluate("window.__result")) as { errors: string[]; corner: number[]; line: number[] };
      expect(r.errors).toEqual(["wasm_unavailable"]);
      expect(origin.log.filter((l) => l.method === "GET")).toHaveLength(0);
      expect(r.corner.slice(0, 3)).toEqual([0xdf, 0xe7, 0xee]);
      expect(r.line.slice(0, 3)).toEqual([0x11, 0x22, 0x33]);
    } finally {
      s.server.close();
      await origin.stop();
    }
  });
});
void mkdirSync;
