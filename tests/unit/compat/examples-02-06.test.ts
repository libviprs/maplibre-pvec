import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const BUILT = ["01-minimal", "02-georeferenced", "06-georeference-update"];
const BLOCKED = ["03-refinement", "04-large-budget", "05-picking"];

describe("#124 examples 02 and 06 (slice of #84)", () => {
  it("the built examples have a page, a script and a runner, and the blocked ones are not faked", () => {
    const dirs = readdirSync(join(root, "examples")).filter((d) => /^\d\d-/.test(d)).sort();
    expect(dirs).toEqual(BUILT);
    for (const d of BUILT) for (const f of ["index.html", "main.js", "run.mjs"]) expect(existsSync(join(root, "examples", d, f)), `${d}/${f}`).toBe(true);
  });

  it("every new runner goes through the shared runner, which denies outbound network and fails on any refused host", () => {
    for (const d of BUILT.slice(1)) expect(read(`examples/${d}/run.mjs`), d).toMatch(/runExample/);
    const run = read("examples/lib/run.mjs");
    expect(run).toMatch(/denyExternal/);
    expect(run).toMatch(/deniedHosts/);
    expect(run).toMatch(/withServer/);
    expect(run).toMatch(/outbound hosts refused/);
  });

  it("each new example puts the real layer on a real map and waits for the layer, not a timer", () => {
    for (const d of BUILT.slice(1)) {
      const main = read(`examples/${d}/main.js`);
      expect(main, d).toMatch(/from "\/pkg\/index\.js"/);
      expect(main, d).toMatch(/addLayer\(/);
      expect(main, d).toMatch(/whenReady\(\)/);
      expect(main, d).not.toMatch(/setTimeout\(/);
    }
    expect(read("examples/lib/map.js")).not.toMatch(/setTimeout\(|setInterval\(/);
  });

  it("02 supplies a georeference, 06 swaps it with layer.update and checks that nothing was requested again", () => {
    expect(read("examples/02-georeferenced/main.js")).toMatch(/georeference: \{ reference/);
    expect(read("examples/06-georeference-update/main.js")).toMatch(/\.update\(\{ georeference/);
    expect(read("examples/06-georeference-update/run.mjs")).toMatch(/asked the server for the file/);
  });

  it("the expected pixels come from lib/truth.mjs, which does not import the add-on", async () => {
    expect(read("examples/lib/truth.mjs")).not.toMatch(/import /);
    const t = (await import(/* @vite-ignore */ join(root, "examples/lib/truth.mjs"))) as typeof import("../../../examples/lib/truth.mjs");
    const cal = t.calibration({ dLng: 1e-4 });
    const [lng, lat] = t.lngLatOf(75, 47.5, cal);
    const [x, y] = t.sourceOf(lng, lat, cal);
    expect([x, y].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([75, 47.5]);
    expect(t.expectedAt(75, 47.5)).toEqual([Math.round(t.ramp(75)), Math.round(t.ramp(75)), Math.round(t.ramp(75))]);
    expect(t.expectedAt(10, 150)).toEqual(t.BACKGROUND);
    expect(t.expectedAt(25.5, 40), "near the edge a filter may blend, so no claim").toBeUndefined();
  });

  it("the summary writes the run record, and exits 0 only with all six examples passed and no refused host", () => {
    const sum = join(root, "examples/lib/summary.mjs");
    const run = (results: object[]) => {
      const dir = mkdtempSync(join(tmpdir(), "ex-sum-"));
      results.forEach((r, i) => writeFileSync(join(dir, `0${i + 1}-x.result.json`), JSON.stringify(r)));
      const p = spawnSync("node", [sum, dir], { encoding: "utf8" });
      return { status: p.status, summary: JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as { results: object[]; deniedHosts: string[] } };
    };
    const ok = (n: number) => ({ example: `0${n}-x`, ok: true, deniedHosts: [] });
    const three = run([ok(1), ok(2), ok(3)]);
    expect(three.status, "three of six is not a pass").toBe(1);
    expect(three.summary.results).toHaveLength(3);
    expect(run([1, 2, 3, 4, 5, 6].map(ok)).status).toBe(0);
    expect(run([...[1, 2, 3, 4, 5].map(ok), { example: "06-x", ok: true, deniedHosts: ["example.com"] }]).status).toBe(1);
  });

  it("run-all.sh runs every example, writes one summary and installs MapLibre next to the package", () => {
    const sh = read("examples/run-all.sh");
    expect(sh).toMatch(/summary\.json/);
    expect(sh).toMatch(/examples\/lib\/summary\.mjs/);
    expect(sh).toMatch(/maplibre-gl/);
  });

  it("the README says which examples run and names what blocks each of the others", () => {
    const rows = read("examples/README.md").split("\n").filter((l) => /^\| `0\d-/.test(l));
    expect(rows).toHaveLength(6);
    for (const d of BUILT) expect(rows.find((r) => r.includes(`\`${d}\``)), d).toMatch(/\| runs \|/);
    for (const d of BLOCKED) expect(rows.find((r) => r.includes(`\`${d}`)), d).toMatch(/\| blocked \|/);
  });

  it("the committed run record lists the examples that ran, all passing, with no refused host", () => {
    const rec = JSON.parse(read("release/examples-run.json")) as { results: Array<{ example: string; ok: boolean }>; deniedHosts: string[] };
    expect(rec.results.map((r) => r.example).sort()).toEqual(BUILT);
    expect(rec.results.every((r) => r.ok)).toBe(true);
    expect(rec.deniedHosts).toEqual([]);
  });

  it("the release gate reads that record and stays unmet until six examples have passed", () => {
    expect(read("tools/release-gate.mjs")).toMatch(/examples-run\.json/);
    const gate = JSON.parse(read("release/v1-gate.json")) as { conditions: Array<{ id: string; status: string; measured: { examplesPassed: number; examplesPlanned: number } }> };
    const c = gate.conditions.find((x) => x.id === "examples_pass_network_denied")!;
    expect(c.measured.examplesPassed).toBe(3);
    expect(c.measured.examplesPlanned).toBe(6);
    expect(c.status).not.toBe("met");
  });
});

describe("#84 docs samples resolve against the M7.8 fixture server", () => {
  it("every localhost url in a docs code sample is served by the fixture server as a .pvec container", async () => {
    const { docsFixtures } = (await import(/* @vite-ignore */ join(root, "examples/lib/fixtures.mjs"))) as { docsFixtures: () => Record<string, Uint8Array> };
    const { withServer } = (await import(/* @vite-ignore */ join(root, "examples/lib/serve.mjs"))) as { withServer: (o: object, f: (s: { url: string }) => Promise<void>) => Promise<void> };
    const pages = readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md") && f !== "deferred.md");
    const paths = new Set<string>();
    for (const f of pages) {
      for (const block of read(`docs/${f}`).matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
        for (const u of block[1]!.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(\/[^\s'"`)]*)/g)) paths.add(u[1]!);
      }
    }
    expect(paths.size).toBeGreaterThan(0);
    await withServer({ fixtures: docsFixtures() }, async (s) => {
      for (const p of paths) {
        const r = await fetch(`${s.url}${p}`, { headers: { range: "bytes=0-4" } });
        expect(r.status, p).toBe(206);
        expect([...new Uint8Array(await r.arrayBuffer())], p).toEqual([0x89, 0x50, 0x56, 0x45, 0x43]);
      }
    });
  });
});
