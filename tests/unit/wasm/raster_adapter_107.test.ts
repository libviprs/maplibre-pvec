import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadEvaluator } from "../../../src/wasm/loader";
import { hasRasterExports, openRasterProvider } from "../../../src/wasm/raster";
import { RasterRefusedError } from "../../../src/render/raster/provider";
import { EVALUATOR_WASM_BYTES } from "../helpers/probe";

// Issues 102 and 107: the adapter from the pvec-wasm raster exports to the renderer's provider seam, on the real module. The files are
// written by pvec's test-only writer (tools/pvec-raster-fixtures.sh), the thirteen hostile tiles are the corpus of
// libviprs/pvec crates/pvec-testkit/src/raster_hostile.rs, and every refusal here is the module's own sniffer speaking.

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dir = join(root, "tests/fixtures/pvec-raster");
const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as { tiles: { kind: string; name: string; rule: string | null }[] };
const evaluator = async () => loadEvaluator({ wasmModule: await WebAssembly.compile(EVALUATOR_WASM_BYTES) });
const reader = (bytes: Uint8Array) => ({
  artifactLength: bytes.length as number | undefined,
  readRange: (o: number, n: number) => Promise.resolve(bytes.slice(o, o + n)),
});
const file = (rel: string) => new Uint8Array(readFileSync(join(dir, rel)));
const PNG = [0x89, 0x50, 0x4e, 0x47];

describe("#102 the module has the raster exports", () => {
  it("is ABI 2 and carries every export the adapter probes", async () => {
    const ev = await evaluator();
    expect(ev.abiVersion).toBe(2);
    expect(hasRasterExports(ev)).toBe(true);
  });
});

describe("#102 the adapter over a file with rasters", () => {
  it("reads the placements as authored, skips the unknown codec with its rule, and hands tiles over untouched", async () => {
    const p = (await openRasterProvider(await evaluator(), reader(file("synthetic.pvec"))))!;
    expect(p).not.toBeNull();
    const ps = p.placements();
    expect(ps.map((x) => x.id)).toEqual([0, 1]);
    expect(ps[0]).toMatchObject({ pixelToSource: [0.5, 0.25, 0.125, -0.5, 100, 50], width: 1024, height: 512, visibleBox: [0, 0, 1024, 512], tileEdge: 256, levels: 3, codec: 1, channels: 1, bitDepth: 8, opacity: 200, band: 1, attribution: 'survey <1998> & "co"' });
    expect(p.skipped!()).toEqual([{ id: 2, rule: "RASTER-04", message: expect.stringContaining("RASTER-04") }]);
    const t = (await p.tile(0, 0, 0, 0))!;
    expect([...t.subarray(0, 4)], "an encoded PNG, not pixels").toEqual(PNG);
    expect(await p.tile(1, 2, 3, 1), "a tile the sparse pyramid does not store").toBeNull();
    expect((await p.tile(1, 2, 0, 0))!.length).toBeGreaterThan(8);
  });

  it("a file without a raster stream is null, and so is a module asked about a file it cannot open", async () => {
    const plain = new Uint8Array(readFileSync(join(root, "tests/fixtures/pvec/line-001.pvec")));
    expect(await openRasterProvider(await evaluator(), reader(plain))).toBeNull();
  });
});

describe("#107 pvec's hostile corpus through pvec's own sniffers", () => {
  const refused = index.tiles.filter((t) => t.kind === "hostile");
  it("lists thirteen refused tiles", () => expect(refused).toHaveLength(13));
  // What the module's ABI names today. A refusal by a RASTER-NN rule is -10 and the adapter turns it into RasterRefusedError with the
  // rule. LIMIT-15 is a read failure (-4) with no rule in the ABI, and a placement stream the writer's rules refuse leaves a file with
  // no raster at all (the Unrastered effect, no rule): both are refused, never handed over, and recorded as such here.
  const NO_RULE_IN_THE_ABI = new Set(["oversized-tile", "tile-at-limit-15-plus-one"]);
  const STREAM_REFUSED = new Set(["jpeg-under-an-rgba-placement"]);
  for (const t of refused) {
    it(`${t.name} is refused (${t.rule}) and never handed over`, async () => {
      const p = await openRasterProvider(await evaluator(), reader(file(`hostile/${t.name}.pvec`)));
      if (STREAM_REFUSED.has(t.name)) {
        expect(p, "the stream is refused whole: no raster, the Unrastered effect").toBeNull();
        return;
      }
      expect(p).not.toBeNull();
      let rule: string | undefined;
      if (p!.placements().length === 0) {
        rule = p!.skipped!()[0]?.rule;
      } else {
        const got = await p!.tile(0, 0, 0, 0).then(
          (b) => ({ bytes: b }),
          (e: unknown) => ({ error: e }),
        );
        expect("bytes" in got, `${t.name} must not be returned as an image`).toBe(false);
        const err = (got as { error: Error }).error;
        if (NO_RULE_IN_THE_ABI.has(t.name)) {
          expect(err).not.toBeInstanceOf(RasterRefusedError);
          expect(err.message).toMatch(/-4/);
          return;
        }
        expect(err).toBeInstanceOf(RasterRefusedError);
        rule = (err as RasterRefusedError).rule;
      }
      expect(rule).toBe(t.rule);
    });
  }

  const accepted = index.tiles.filter((t) => t.kind === "accepted");
  for (const t of accepted) {
    it(`${t.name} passes the sniffers (its body is not an image, so the browser calls it a missing tile)`, async () => {
      const p = (await openRasterProvider(await evaluator(), reader(file(`accepted/${t.name}.pvec`))))!;
      expect(p.placements()).toHaveLength(1);
      const b = await p.tile(0, 0, 0, 0);
      expect(b!.length).toBeGreaterThan(8);
    });
  }
});
