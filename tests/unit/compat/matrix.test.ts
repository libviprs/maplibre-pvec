import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCompatibility } from "../../../src/compat/render";
import { COMPAT, UNSUPPORTED_ROWS, peerRange } from "../../../src/compat/matrix";
import { assertMapLibreVersion, assertWebGL2 } from "../../../src/compat/detect";
import { PVecSource } from "../../../src/source/PVecSource";
import { PVecError } from "../../../src/source/errors";
import { buildPvec, gridSpec } from "../helpers/fixture";
import { RangeOrigin } from "../helpers/origin";

const root = join(__dirname, "../../..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

describe("#31 M7.7 compatibility matrix generation", () => {
  it("docs/compatibility.md and compatibility.json equal the generated output", () => {
    const out = renderCompatibility(COMPAT);
    expect(read("docs/compatibility.md")).toBe(out.markdown);
    expect(read("compatibility.json")).toBe(out.json);
  });

  it("the package.json peer range is the range derived from the MapLibre rows", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.peerDependencies["maplibre-gl"]).toBe(peerRange(COMPAT));
    expect(peerRange(COMPAT)).toBe(">=4.7.1 <7.0.0");
  });

  it("the lowest and highest tested MapLibre versions are both devDependencies the suite imports", () => {
    const pkg = JSON.parse(read("package.json"));
    const versions = COMPAT.maplibre.map((r) => r.version);
    const installed = Object.entries(pkg.devDependencies as Record<string, string>)
      .filter(([k]) => k.startsWith("maplibre-gl"))
      .map(([, v]) => v.replace(/^npm:maplibre-gl@/, ""));
    expect(installed).toEqual(expect.arrayContaining([versions[0], versions[versions.length - 1]]));
  });

  it("every supported browser row is in the Playwright grid", () => {
    const cfg = read("playwright.config.ts");
    const declared = [...cfg.matchAll(/name:\s*["'](\w+)["']/g)].map((m) => m[1]);
    const grid = declared.length > 0 ? declared : ["chromium"];
    for (const row of COMPAT.browsers.filter((b) => b.status === "supported")) {
      expect(grid, `browser row ${row.engine} is not in the grid`).toContain(row.engine);
    }
  });

  it("WebGPU appears in no supported table of the generated document", () => {
    const { markdown, json } = renderCompatibility(COMPAT);
    const supported = markdown.split("\n## ").filter((s) => !/^(Experimental|Unsupported)/.test(s));
    for (const s of supported) expect(s.toLowerCase()).not.toContain("webgpu");
    const j = JSON.parse(json);
    expect(JSON.stringify(j.browsers).toLowerCase()).not.toContain("webgpu");
    expect(j.experimental.find((e: { id: string }) => e.id === "webgpu").supported).toBe(false);
  });

  it("exactly one projection row is the conformance baseline and it is mercator", () => {
    const base = COMPAT.projections.filter((p) => p.baseline);
    expect(base.map((p) => p.id)).toEqual(["mercator"]);
  });

  it("every unsupported-combination row names a test title that exists", () => {
    const dir = join(root, "tests/unit");
    const files = [...readdirSync(dir).map((f) => join(dir, f)), ...readdirSync(join(dir, "compat")).map((f) => join(dir, "compat", f))].filter((f) => f.endsWith(".test.ts"));
    const text = files.map((f) => readFileSync(f, "utf8")).join("\n");
    for (const row of UNSUPPORTED_ROWS) {
      expect(text, `no test for row ${row.id}`).toContain(`it("${row.id} `);
    }
  });
});

describe("#31 unsupported-combination rows, detection stubbed", () => {
  it("U1 unsupported maplibre major refuses with the tested range in the message", () => {
    for (const v of ["3.6.2", "4.7.0", "7.0.0"]) {
      const e = catchErr(() => assertMapLibreVersion(v));
      expect(e).toBeInstanceOf(PVecError);
      expect(e.code).toBe("unsupported_maplibre_version");
      expect(e.message).toContain(">=4.7.1 <7.0.0");
    }
    for (const v of ["4.7.1", "5.24.0", "6.16.0", "6.99.1"]) expect(() => assertMapLibreVersion(v)).not.toThrow();
  });

  it("U2 no WebGL2 refuses with webgl2_required and no canvas2D fallback", () => {
    const e = catchErr(() => assertWebGL2({ constructor: { name: "WebGLRenderingContext" } }));
    expect(e.code).toBe("webgl2_required");
    expect(e.message.toLowerCase()).toContain("no canvas2d fallback");
    expect(catchErr(() => assertWebGL2(null)).code).toBe("webgl2_required");
    expect(() => assertWebGL2(new (class WebGL2RenderingContext {})() as never)).not.toThrow();
  });

  it("U3 a required capability the reader lacks refuses with required-unsupported", async () => {
    const origin = new RangeOrigin(buildPvec(gridSpec({ capabilities: [{ id: 1 }, { id: 99 }] })).bytes);
    const base = await origin.start();
    const err = await new PVecSource({ url: `${base}/p.pvec` }).bootstrap().catch((e: unknown) => e);
    await origin.stop();
    expect((err as PVecError).code).toBe("required-unsupported");
  });

  it("U4 an optional capability the reader lacks degrades and is reported", async () => {
    const origin = new RangeOrigin(buildPvec(gridSpec({ capabilities: [{ id: 1 }, { id: 17, required: false }] })).bytes);
    const base = await origin.start();
    const h = await new PVecSource({ url: `${base}/p.pvec` }).bootstrap();
    await origin.stop();
    expect(h.report.unsupportedOptional).toEqual([{ id: 17, name: "hatch" }]);
  });

  it("U5 the accepted PVec reader version is 1.0.0 and nothing newer", async () => {
    const origin = new RangeOrigin(buildPvec(gridSpec({ minReader: [1, 0, 1] })).bytes);
    const base = await origin.start();
    const err = await new PVecSource({ url: `${base}/p.pvec` }).bootstrap().catch((e: unknown) => e);
    await origin.stop();
    expect((err as PVecError).code).toBe("reader-too-old");
    expect(COMPAT.pvec.readerVersion).toBe("1.0.0");
  });
});

function catchErr(f: () => void): PVecError {
  try {
    f();
  } catch (e) {
    return e as PVecError;
  }
  throw new Error("did not throw");
}
