import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Issue 102: the texture constant, the decode milliseconds per tile per codec and the uploads per frame are measured and
// written down with the machine named. Red until release/evidence/102-raster.json (tools/evidence-102.mjs, from the Playwright
// run) and docs/raster-render.md are in.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("#102 recorded raster measurements", () => {
  const file = path.join(root, "release/evidence/102-raster.json");
  it("the evidence file carries the constant, decode time per codec and uploads per frame, from a named machine", () => {
    expect(existsSync(file)).toBe(true);
    const e = JSON.parse(readFileSync(file, "utf8"));
    expect(e.environment).toMatch(/\S/);
    expect(e.textureBytesPerTile).toBe(256 * 256 * 4);
    for (const codec of ["png", "png1", "jpeg"]) expect(e.decodeMsPerTile[codec].length).toBeGreaterThan(0);
    expect(e.uploadsPerFrame.length).toBeGreaterThan(0);
    expect(Math.max(...e.uploadsPerFrame)).toBeGreaterThan(0);
  });

  it("software GL is labelled as such wherever its numbers appear", () => {
    const e = JSON.parse(readFileSync(file, "utf8"));
    expect(e.renderer).toMatch(/software GL|SwiftShader|GPU/);
    const doc = readFileSync(path.join(root, "docs/raster-render.md"), "utf8");
    expect(doc).toMatch(/software GL/i);
    expect(doc).toMatch(/texture constant/i);
    expect(doc).toMatch(/decode/i);
    expect(doc).toMatch(/uploads per frame/i);
    expect(doc).toContain(e.environment);
  });

  it("the ADR records the quad path, the rejected protocol adapter and the seam", () => {
    const adr = readFileSync(path.join(root, "docs/adr/0009-raster-quads.md"), "utf8");
    expect(adr).toMatch(/pvec-raster:\/\//);
    expect(adr).toMatch(/seam/i);
    expect(adr).toMatch(/draw order/i);
    expect(adr).toMatch(/decode in the host/i);
  });
});
