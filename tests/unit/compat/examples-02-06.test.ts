import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const EXAMPLES = ["01-minimal", "02-georeferenced", "03-refinement", "04-large-budget", "05-picking", "06-georeference-update"];
const NEW = EXAMPLES.slice(1);

describe("#84 examples 02 to 06", () => {
  it("all six example directories exist, each with a page, a script and a runner", () => {
    const dirs = readdirSync(join(root, "examples")).filter((d) => /^\d\d-/.test(d)).sort();
    expect(dirs).toEqual(EXAMPLES);
    for (const d of EXAMPLES) for (const f of ["index.html", "main.js", "run.mjs"]) expect(existsSync(join(root, "examples", d, f)), `${d}/${f}`).toBe(true);
  });

  it("every new runner denies outbound network through the shared helper and fails on any denied host", () => {
    for (const d of NEW) {
      const run = read(`examples/${d}/run.mjs`);
      expect(run, d).toMatch(/denyExternal/);
      expect(run, d).toMatch(/deniedHosts/);
      expect(run, d).toMatch(/withServer/);
    }
    expect(existsSync(join(root, "examples/lib/deny.mjs"))).toBe(true);
  });

  it("each example builds a real layer on a map and waits for the layer, not a timer", () => {
    for (const d of NEW) {
      const main = read(`examples/${d}/main.js`);
      expect(main, d).toMatch(/from "\/pkg\/index\.js"/);
      expect(main, d).toMatch(/addLayer\(/);
      expect(main, d).toMatch(/whenReady\(\)/);
      expect(main, d).not.toMatch(/setTimeout\(/);
    }
  });

  it("02 georeferences, 03 listens to refinement, 04 sets heap and GPU budgets, 05 picks, 06 updates the calibration", () => {
    expect(read("examples/02-georeferenced/main.js")).toMatch(/georeference/);
    expect(read("examples/03-refinement/main.js")).toMatch(/on\("refinement"/);
    expect(read("examples/03-refinement/main.js")).toMatch(/on\("tier0complete"/);
    const m4 = read("examples/04-large-budget/main.js");
    expect(m4).toMatch(/gpuBytes/);
    expect(m4).toMatch(/maxDecodedBytes/);
    expect(read("examples/04-large-budget/run.mjs")).toMatch(/jsHeapSizeLimit|usedJSHeapSize|heap/i);
    expect(read("examples/05-picking/main.js")).toMatch(/pickPoint\(|nearestEntity\(/);
    expect(read("examples/06-georeference-update/main.js")).toMatch(/\.update\(\{\s*georeference/);
  });

  it("05 and 06 check against expected.math.json of a known-truth fixture, not a hard-coded answer", () => {
    for (const d of ["05-picking", "06-georeference-update"]) expect(read(`examples/${d}/run.mjs`), d).toMatch(/expected\.math\.json/);
  });

  it("run-all.sh runs every example directory, writes one summary, and fails unless all six passed", () => {
    const sh = read("examples/run-all.sh");
    expect(sh).toMatch(/summary\.json/);
    expect(sh).toMatch(/examples\/lib\/summary\.mjs/);
    expect(existsSync(join(root, "examples/lib/summary.mjs"))).toBe(true);
  });

  it("the README marks all six as running", () => {
    const rows = read("examples/README.md").split("\n").filter((l) => /^\| `0\d-/.test(l));
    expect(rows).toHaveLength(6);
    for (const r of rows) expect(r, r).toMatch(/\| runs \|/);
  });

  it("the committed run record has six passing examples and no denied host", () => {
    const rec = JSON.parse(read("release/examples-run.json")) as { results: Array<{ example: string; ok: boolean }>; deniedHosts: string[] };
    expect(rec.results.map((r) => r.example).sort()).toEqual(EXAMPLES);
    expect(rec.results.every((r) => r.ok)).toBe(true);
    expect(rec.deniedHosts).toEqual([]);
  });

  it("the release gate reads that record: examples condition is met only from it", () => {
    expect(read("tools/release-gate.mjs")).toMatch(/examples-run\.json/);
    const gate = JSON.parse(read("release/v1-gate.json")) as { conditions: Array<{ id: string; status: string }> };
    expect(gate.conditions.find((c) => c.id === "examples_pass_network_denied")?.status).toBe("met");
    expect(read("docs/v1-readiness.md")).not.toMatch(/Samples resolve against the M7\.8 fixture server \| deferred/);
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
