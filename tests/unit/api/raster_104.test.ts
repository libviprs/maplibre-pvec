import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPVecLayer, PVecOptionError, type PVecEventName } from "../../../src/index";
import { EVENT_NAMES } from "../../../src/diagnostics/events";
import { COMPAT, UNSUPPORTED_ROWS } from "../../../src/compat/matrix";
import { configureEngine } from "../../../src/layer/internal";
import type { RasterProvider } from "../../../src/render/raster/provider";
import type { RasterPlacement } from "../../../src/render/raster/geometry";
import { gridSpec } from "../helpers/fixture";
import { countingGl, fakeMap, rig, type Rig } from "./helpers";

// Issue 104 (RM1.1): the raster names on the public surface. Nothing here draws; it checks what the host can configure and
// what it is told. The freeze moves here are an amendment under the R-M epic (#103).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string): string => readFileSync(path.join(root, p), "utf8");
const evaluator = { instance: {} as WebAssembly.Instance, abiVersion: 2, source: "injected" as const };
const reference = { kind: "affine" as const, unit: "m" as const, crs: { id: "EPSG:4326" } as never, calibration: [1e-5, 0, 0, 1e-5, 0, 0] as const };

let r: Rig;
beforeEach(async () => (r = await rig(gridSpec({ capabilities: [{ id: 1 }, { id: 4 }, { id: 5 }, { id: 6 }, { id: 21, required: false } as never] }))));
afterEach(async () => r.stop());

function placement(id: number, over: Partial<RasterPlacement> = {}): RasterPlacement {
  return { id, pixelToSource: [1, 0, 0, -1, 0, 0], width: 512, height: 512, visibleBox: [0, 0, 512, 512], tileEdge: 256, levels: 2, codec: 1, channels: 4, bitDepth: 8, opacity: 255, band: 0, ...over };
}
function provider(ps: RasterPlacement[], skipped: { id: number; rule: string; message: string }[] = []): RasterProvider {
  return { placements: () => ps, skipped: () => skipped, tile: () => Promise.resolve(null) } as RasterProvider;
}
async function loaded(opts: { rasters?: RasterProvider | null; georeference?: boolean } = {}) {
  const layer = createPVecLayer({ id: "a", source: { url: r.url }, ...(opts.georeference === false ? {} : { georeference: { reference } }) });
  configureEngine(layer, { loadEvaluator: () => Promise.resolve(evaluator), openRasters: () => Promise.resolve(opts.rasters ?? null), spawnDecode: () => ({ postMessage() {}, onmessage: null, terminate() {} }) });
  const seen: { type: string; event: unknown }[] = [];
  for (const n of EVENT_NAMES) layer.on(n, (event) => void seen.push({ type: n, event }));
  const { gl } = countingGl();
  layer.onAdd(fakeMap, gl);
  await layer.whenReady();
  return { layer, seen, gl, off: () => layer.onRemove(fakeMap, gl) };
}

describe("#104 the raster option", () => {
  it("accepts a boolean for raster.enabled, and omitting the group is the same as true", () => {
    expect(() => createPVecLayer({ id: "a", source: { url: r.url }, raster: { enabled: true } })).not.toThrow();
    expect(() => createPVecLayer({ id: "a", source: { url: r.url }, raster: { enabled: false } })).not.toThrow();
    expect(() => createPVecLayer({ id: "a", source: { url: r.url }, raster: {} })).not.toThrow();
    expect(() => createPVecLayer({ id: "a", source: { url: r.url } })).not.toThrow();
  });

  it("refuses anything else with PVecOptionError", () => {
    for (const bad of ["yes", 1, 0, null, {}, []]) {
      expect(() => createPVecLayer({ id: "a", source: { url: r.url }, raster: { enabled: bad as never } }), String(bad)).toThrow(PVecOptionError);
    }
    for (const bad of [true, "on", 1, []]) {
      expect(() => createPVecLayer({ id: "a", source: { url: r.url }, raster: bad as never }), String(bad)).toThrow(PVecOptionError);
    }
  });

  it("update({ raster }) is accepted, a bad value is refused and leaves the layer as it was", () => {
    const layer = createPVecLayer({ id: "a", source: { url: r.url } });
    expect(() => layer.update({ raster: { enabled: false } })).not.toThrow();
    expect(() => layer.update({ raster: { enabled: "no" as never } })).toThrow(PVecOptionError);
    expect(() => layer.update({ raster: { enabled: true } })).not.toThrow();
  });

  it("there is no texture budget option: textures share cache.gpuBytes and bitmaps share limits.maxDecodedBytes", () => {
    const report = read("etc/maplibre-pvec.api.md");
    expect(report).toMatch(/raster\?: \{[^}]*enabled\?: boolean;[^}]*\}/);
    expect(report).not.toMatch(/rasterBytes|rasterBudget|textureBudget/i);
  });
});

describe("#104 diagnostics and events", () => {
  it("the snapshot carries rasters: zeros without a raster stream, drawn and skipped otherwise", async () => {
    const none = await loaded({ rasters: null });
    expect(none.layer.getDiagnostics().rasters).toEqual({ drawn: 0, skipped: 0, textureBytes: 0, decodesInFlight: 0 });
    none.off();
    const { layer, off } = await loaded({ rasters: provider([placement(0), placement(1, { codec: 9 })]) });
    expect(layer.getDiagnostics().rasters).toEqual({ drawn: 1, skipped: 1, textureBytes: 0, decodesInFlight: 0 });
    off();
  });

  it("rasterskipped is in the catalogue", () => {
    const all: PVecEventName[] = ["capabilities", "bytes", "tier0complete", "refinement", "capabilityunsupported", "rasterskipped", "error"];
    expect([...EVENT_NAMES].sort()).toEqual([...all].sort());
  });

  it("a stub provider that reports one skipped raster emits exactly one rasterskipped with its rule, and nothing else about rasters", async () => {
    const { seen, off } = await loaded({ rasters: provider([placement(0), placement(1)], [{ id: 1, rule: "RASTER-03", message: "the PNG header says 512 by 512, the placement says 256" }]) });
    expect(seen.filter((s) => s.type === "rasterskipped").map((s) => s.event)).toEqual([
      { rasterId: 1, rule: "RASTER-03", message: "the PNG header says 512 by 512, the placement says 256" },
    ]);
    expect(seen.filter((s) => s.type === "capabilityunsupported")).toEqual([]);
    expect(seen.filter((s) => s.type === "error")).toEqual([]);
    off();
  });

  it("an unknown codec id and a JPEG with alpha are skips with their own reason under RASTER-04, once each", async () => {
    const { seen, off } = await loaded({ rasters: provider([placement(0, { codec: 9 }), placement(1, { codec: 2, channels: 4 }), placement(2)]) });
    const skipped = seen.filter((s) => s.type === "rasterskipped").map((s) => s.event as { rasterId: number; rule: string; message: string });
    expect(skipped.map((e) => [e.rasterId, e.rule])).toEqual([[0, "RASTER-04"], [1, "RASTER-04"]]);
    expect(skipped[0]!.message).toMatch(/codec/i);
    expect(skipped[1]!.message).toMatch(/jpeg/i);
    off();
  });

  it("a module without the exports reports capabilityunsupported for raster once, and nothing else", async () => {
    const { seen, off } = await loaded({ rasters: null });
    expect(seen.filter((s) => s.type === "capabilityunsupported").map((s) => s.event)).toEqual([{ capability: "raster", required: false, action: "ignored" }]);
    expect(seen.filter((s) => s.type === "rasterskipped" || s.type === "error")).toEqual([]);
    off();
  });

  it("a module that has the exports does not report the raster capability as unsupported", async () => {
    const { seen, off } = await loaded({ rasters: provider([placement(0)]) });
    expect(seen.filter((s) => s.type === "capabilityunsupported")).toEqual([]);
    const caps = seen.find((s) => s.type === "capabilities")!.event as { unsupportedOptional: string[] };
    expect(caps.unsupportedOptional).not.toContain("raster");
    off();
  });

  it("a file without a raster stream emits the event stream it did before", async () => {
    await r.stop();
    r = await rig();
    const { seen, off } = await loaded({ rasters: null });
    expect(seen.map((s) => s.type)).toEqual(["capabilities", "bytes"]);
    off();
  });
});

describe("#104 rasters()", () => {
  it("is empty before the layer is added and when the file has no rasters", async () => {
    expect(createPVecLayer({ id: "a", source: { url: r.url } }).rasters()).toEqual([]);
    const { layer, off } = await loaded({ rasters: null });
    expect(layer.rasters()).toEqual([]);
    off();
  });

  it("returns id, width, height, band, opacity and attribution, and escapes the attribution for an HTML sink", async () => {
    const { layer, off } = await loaded({
      rasters: provider([
        placement(0, { attribution: '<script>alert(1)</script> & "Survey" 2024' }),
        placement(1, { band: 1, opacity: 128, width: 1024, height: 768, visibleBox: [0, 0, 1024, 768] }),
      ]),
    });
    expect(layer.rasters()).toEqual([
      { id: 0, width: 512, height: 512, band: 0, opacity: 255, attribution: "&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Survey&quot; 2024" },
      { id: 1, width: 1024, height: 768, band: 1, opacity: 128, attribution: "" },
    ]);
    off();
  });

  it("does not list a skipped raster", async () => {
    const { layer, off } = await loaded({ rasters: provider([placement(0, { codec: 9 }), placement(1)]) });
    expect(layer.rasters().map((x) => x.id)).toEqual([1]);
    off();
  });
});

describe("#104 compatibility row and surface", () => {
  it("raster is an optional capability, and the rows for an optional unknown capability (U3, U4) are unchanged", () => {
    expect(COMPAT.pvec.optionalCapabilities).toContain("raster");
    expect(COMPAT.pvec.requiredCapabilities).not.toContain("raster");
    expect(UNSUPPORTED_ROWS.find((u) => u.id === "U3")).toEqual({
      id: "U3",
      combination: "required PVec capability not implemented",
      code: "unsupported_required_capability",
      outcome: "refuse before any payload byte; a wrong major of a known capability uses the same code with detail.reason set to version",
    });
    expect(UNSUPPORTED_ROWS.find((u) => u.id === "U4")).toMatchObject({ code: "degrade" });
    expect(read("docs/compatibility.md")).toMatch(/optional capabilities: .*\braster\b/);
  });

  it("the frozen compatibility block carries the capability", () => {
    expect(JSON.parse(read("release/v1-freeze.json")).compatibility.pvec.optionalCapabilities).toContain("raster");
  });

  it("every new name is exported, in the report and in docs/api/public-surface.md", () => {
    const report = read("etc/maplibre-pvec.api.md");
    const doc = read("docs/api/public-surface.md");
    for (const n of ["RasterInfo", "RasterSkippedEvent"]) {
      expect(report, n).toMatch(new RegExp(`^### ${n}$`, "m"));
      expect(doc, n).toMatch(new RegExp(`^\\| \`${n}\` \\| type \\|`, "m"));
    }
    expect(report).toMatch(/rasters\(\): RasterInfo\[\]/);
    expect(report).toMatch(/rasterskipped: RasterSkippedEvent/);
    expect(doc).toMatch(/rasters\(\)/);
  });

  it("the changelog records the change as minor", () => {
    expect(read("CHANGELOG.md")).toMatch(/raster[\s\S]{0,400}minor|minor[\s\S]{0,400}raster/i);
  });
});
