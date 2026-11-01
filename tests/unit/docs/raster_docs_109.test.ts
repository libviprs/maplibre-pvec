import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PAGES, generateDocs, listDocPages } from "../../../tools/docs.mjs";

// Issue 109: example 07 and the raster documentation. One page per subject, reachable from the index, naming every rule the module
// can refuse a raster by, with the quoted numbers carrying their renderer and arch.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

/** One heading per subject the issue lists. */
const SUBJECTS: [string, RegExp][] = [
  ["how a tile gets to the screen", /^## How a tile gets to the screen/m],
  ["the level rule and overzoom", /^## The level rule and overzoom/m],
  ["bands and RasterId order", /^## Bands and RasterId order/m],
  ["opacity", /^## Opacity/m],
  ["visible_box and the padded edge", /^## `visible_box` and the padded edge/m],
  ["attribution and escaping", /^## Attribution and escaping/m],
  ["tiers and the two caps", /^## The three tiers and the two caps/m],
  ["a skipped raster", /^## A skipped raster/m],
  ["the host decoder contract", /^## The host decoder contract/m],
  ["the accepted one-texel seam", /^## The one-texel seam/m],
  ["what is not drawn", /^## What is not drawn/m],
];

describe("#109 docs/raster.md", () => {
  const page = () => read("docs/raster.md");
  it("exists and is in the page table, so the index and the one-page-per-subject test see it", () => {
    expect(existsSync(path.join(root, "docs/raster.md"))).toBe(true);
    const p = PAGES.find((x: { path: string }) => x.path === "raster.md");
    expect(p, "PAGES has raster.md").toBeDefined();
    expect(PAGES.filter((x: { subject: string }) => x.subject === p!.subject)).toHaveLength(1);
  });
  it.each(SUBJECTS)("has a heading for %s", (_n, re) => expect(page()).toMatch(re));
  it("names every rule a raster can be refused by", () => {
    for (const r of ["RASTER-01", "RASTER-02", "RASTER-03", "RASTER-04", "RASTER-05", "RASTER-06", "RASTER-07", "LIMIT-15", "LIMIT-16"]) expect(page(), r).toContain(r);
  });
  it("is reachable from docs/README.md and the index has no orphan and no dead link", () => {
    expect(read("docs/README.md")).toContain("(raster.md)");
    const all = listDocPages(root);
    const idx = read("docs/README.md");
    for (const f of all) if (f !== "README.md" && !f.startsWith("spikes/") && !/^adr\/\d{4}/.test(f)) expect(idx, f).toContain(`(${f})`);
    for (const f of all) {
      for (const m of read(`docs/${f}`).matchAll(/\]\(((?!https?:|#|mailto:)[^)\s#]+)(#[^)]*)?\)/g)) {
        expect(existsSync(path.join(root, "docs", path.dirname(f), m[1]!)), `${f} -> ${m[1]}`).toBe(true);
      }
    }
  });
  it("quotes measured numbers only with their renderer and arch, calls them display fidelity, and uses no mathematical tolerance", () => {
    const t = page();
    expect(t).toMatch(/display fidelity/i);
    expect(t).not.toMatch(/\bexact(ly)? (match|equal)|within \d+(\.\d+)? ?(ulp|epsilon)|tolerance of/i);
    // every table row that quotes a millisecond figure names a renderer and an arch in the same row
    for (const line of t.split("\n").filter((l) => /^\|/.test(l) && /\d+(\.\d+)? ms/.test(l))) expect(line, line).toMatch(/(arm64|x64)/);
    for (const m of t.matchAll(/https?:\/\/([^/\s"'`)<>]+)/g)) expect(["127.0.0.1", "localhost", "github.com"], m[0]).toContain(m[1]!.replace(/:\d+$/, ""));
  });
  it("is current with the generated pages: docs:check is clean and red on a hand edit", () => {
    for (const [f, text] of generateDocs(root)) {
      expect(read(f), f).toBe(text);
      expect(read(f) + "x", f).not.toBe(text);
    }
  });
  it("the neighbouring pages carry the raster paragraphs the issue lists", () => {
    expect(read("docs/security-resource-limits.md")).toMatch(/raster[\s\S]*decoder[\s\S]*LIMIT-16|LIMIT-16[\s\S]*raster[\s\S]*decoder/i);
    expect(read("docs/range-cache-model.md")).toMatch(/raster tile/i);
    expect(read("docs/georeferencing.md")).toMatch(/one affine per raster/i);
    expect(read("docs/deferred.md")).toMatch(/^## #109 /m);
    expect(read("CHANGELOG.md")).toMatch(/example 07[\s\S]*minor|minor[\s\S]*example 07/i);
    expect(read("CHANGELOG.md")).toMatch(/software GL/);
  });
  it("the compatibility page lists raster as optional", () => {
    expect(read("docs/compatibility.md")).toMatch(/raster[^\n]*optional|optional[^\n]*raster/i);
  });
});

describe("#109 example 07", () => {
  const dir = "examples/07-raster-underlay";
  it("has its page, script, runner and style", () => {
    for (const f of ["index.html", "main.js", "run.mjs", "style.css"]) expect(existsSync(path.join(root, dir, f)), f).toBe(true);
  });
  it("is listed in examples/README.md and run by examples/run-all.sh (which runs every examples/0*/run.mjs)", () => {
    expect(read("examples/README.md")).toContain("07-raster-underlay");
    expect(read("examples/run-all.sh")).toMatch(/examples\/0\*\//);
    const runners = readdirSync(path.join(root, "examples")).filter((d) => /^0\d-/.test(d) && statSync(path.join(root, "examples", d)).isDirectory() && existsSync(path.join(root, "examples", d, "run.mjs")));
    expect(runners).toContain("07-raster-underlay");
  });
  it("reaches no file under src/style, src/text or src/hatch unless it imports them on purpose", () => {
    const main = read(`${dir}/main.js`);
    for (const sub of ["style", "text", "hatch"]) expect(main, sub).not.toMatch(new RegExp(`/pkg/${sub}\\b|src/${sub}`));
    expect(main).toMatch(/from "\/pkg\/index\.js"/);
  });
  it("uses a 127.0.0.1 server of its own and denies every other origin", () => {
    const run = read(`${dir}/run.mjs`);
    expect(run).toMatch(/withServer/);
    expect(run).toMatch(/deniedHosts|route\(/);
    expect(run).toMatch(/synthetic\.pvec/);
  });
  it("shows the rasterskipped events, the band and opacity the file carries, and the attribution through MapLibre's control", () => {
    const main = read(`${dir}/main.js`);
    expect(main).toMatch(/rasterskipped/);
    expect(main).toMatch(/\.rasters\(\)/);
    expect(main).toMatch(/customAttribution|AttributionControl/);
    expect(main).toMatch(/raster:\s*\{\s*enabled/);
  });
});
