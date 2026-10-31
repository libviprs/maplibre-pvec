import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../../src/config/defaults";
import {
  chooseLevel,
  compose,
  largestSingularValue,
  tileBound,
  tileQuad,
  tilesInView,
  type Mat6,
  type RasterPlacement,
  type RasterView,
} from "../../../src/render/raster/geometry";
import { fitLevels, takeUploads, tileTextureBytes } from "../../../src/render/raster/budget";
import { classifyRasters, drawOrder, escapeAttribution } from "../../../src/render/raster/policy";
import { budget } from "../helpers/budget";

// Issue 102 (R2.5): the raster path of the custom layer, as pure functions. The test vector below stands in for the one
// RASTER.md will carry (libviprs/pvec#216): a rotated, sheared, y-flipped placement whose singular values are known in
// closed form, so the level is computed by hand and not by the code under test. When RASTER.md lands, the vector moves.

const deg = (d: number) => (d * Math.PI) / 180;
/** Closed-form values agree to twelve digits; compared as rounded numbers so no tolerance literal is involved. */
const to12 = (x: number) => Number(x.toFixed(12));
/** pixel_to_source = lambda * R(30deg) * [[1,1],[0,1]] * diag(1,-1): a unit shear (singular values phi and 1/phi times lambda). */
const PHI = (1 + Math.sqrt(5)) / 2;
function vector(lambda: number, tx = 0, ty = 0): Mat6 {
  const c = Math.cos(deg(30)), s = Math.sin(deg(30));
  // R * S = [[c, c - s], [s, s + c]]; then the y flip negates the second column.
  return [lambda * c, -lambda * (c - s), lambda * s, -lambda * (s + c), tx, ty];
}
const IDENTITY_VIEW = (w = 1920, h = 1080, m: Mat6 = [1, 0, 0, 1, 0, 0]): RasterView => ({ sourceToDevice: m, width: w, height: h });
function placement(over: Partial<RasterPlacement> = {}): RasterPlacement {
  return {
    id: 0, pixelToSource: [1, 0, 0, -1, 0, 0], width: 4096, height: 4096, visibleBox: [0, 0, 4096, 4096],
    tileEdge: 512, levels: 5, codec: 1, channels: 4, bitDepth: 8, opacity: 255, band: 0, ...over,
  };
}

describe("#102 the level rule", () => {
  it("the larger singular value of the pixel-to-device Jacobian, by hand: 0.2 * phi = 0.3236 gives level 3 of 5", () => {
    expect(to12(largestSingularValue(vector(0.2)))).toBe(to12(0.2 * PHI));
    // k = floor(-log2 0.3236) = floor(1.628) = 1 halvings below full resolution, so level 5 - 1 - 1 = 3.
    expect(chooseLevel(placement({ pixelToSource: vector(0.2), levels: 5 }), IDENTITY_VIEW())).toBe(3);
  });

  it("the smaller singular value, the determinant root or the Frobenius norm would pick other levels (the vector tells them apart)", () => {
    const sMin = 0.2 / PHI, geo = 0.2;
    expect(Math.floor(-Math.log2(sMin))).toBe(3);
    expect(Math.floor(-Math.log2(geo))).toBe(2);
    expect(Math.floor(-Math.log2(0.2 * PHI))).toBe(1);
  });

  it("a boundary at exactly one texel per device pixel keeps the finer level, a view past full resolution clamps", () => {
    expect(chooseLevel(placement({ pixelToSource: [0.5, 0, 0, -0.5, 0, 0] }), IDENTITY_VIEW())).toBe(3);
    expect(chooseLevel(placement({ pixelToSource: [1, 0, 0, -1, 0, 0] }), IDENTITY_VIEW())).toBe(4);
    expect(chooseLevel(placement({ pixelToSource: vector(3) }), IDENTITY_VIEW())).toBe(4);
    expect(chooseLevel(placement({ pixelToSource: vector(1e-9) }), IDENTITY_VIEW())).toBe(0);
  });

  it("the view scale enters through the composition: zooming out one octave drops one level", () => {
    const p = placement({ pixelToSource: [1, 0, 0, -1, 0, 0] });
    expect(chooseLevel(p, IDENTITY_VIEW(1920, 1080, [0.25, 0, 0, 0.25, 0, 0]))).toBe(2);
  });
});

describe("#102 tiles in view", () => {
  it("the bound is (ceil(W/edge)+1) * (ceil(H/edge)+1): 20 at 1080p and 54 at 4K with 512 px tiles", () => {
    expect(tileBound(1920, 1080, 512)).toBe(20);
    expect(tileBound(3840, 2160, 512)).toBe(54);
  });

  it("an upright image (d < 0, a negative determinant) is not culled by winding", () => {
    const p = placement({ pixelToSource: [1, 0, 0, -1, 0, 4096] });
    const view = IDENTITY_VIEW(1024, 1024);
    expect(p.pixelToSource[0] * p.pixelToSource[3] - p.pixelToSource[1] * p.pixelToSource[2]).toBeLessThan(0);
    const t = tilesInView(p, view, 4);
    expect(t.length).toBeGreaterThan(0);
    expect(t.length).toBeLessThanOrEqual(tileBound(1024, 1024, 512));
    const flipped = tilesInView(placement({ pixelToSource: [1, 0, 0, 1, 0, 0] }), view, 4);
    expect(flipped.length).toBeGreaterThan(0);
  });

  it("culling against the viewport polygon drops tiles the pixel box of a 45 degree view would have fetched", () => {
    const c = Math.SQRT1_2;
    const p = placement({ pixelToSource: [c, c, -c, c, 0, 0], width: 8192, height: 8192, visibleBox: [0, 0, 8192, 8192], levels: 5 });
    const view = IDENTITY_VIEW(1024, 1024, [1, 0, 0, 1, -5145, 512]);
    const exact = tilesInView(p, view, 4);
    expect(exact.length).toBeGreaterThan(0);
    const box = tilesInView(p, view, 4, { cull: false });
    expect(exact.length).toBeLessThan(box.length);
    // the over-fetch of the pixel box stays within the ADR's 1.8x of the exact set
    expect(box.length / exact.length).toBeLessThanOrEqual(1.8);
  });

  it("the visible_box clip excludes a padded margin: no quad reaches outside it, and a tile wholly in the margin is dropped", () => {
    // 1000 x 700 image on 512 px tiles: the right column and bottom row are padded by the producer.
    const p = placement({ width: 1000, height: 700, visibleBox: [0, 0, 1000, 700], levels: 2 });
    const q = tileQuad(p, 1, 1, 1)!;
    expect(q.px).toEqual([512, 512, 1000, 700]);
    expect(q.uv[0]).toBe(0);
    expect(to12(q.uv[2])).toBe(to12((1000 - 512) / 512));
    expect(to12(q.uv[3])).toBe(to12((700 - 512) / 512));
    // an asymmetric clip: only the pixel rectangle [100, 600) x [50, 300) is visible
    const c = placement({ width: 1000, height: 700, visibleBox: [100, 50, 600, 300], levels: 2 });
    expect(tileQuad(c, 1, 1, 1)).toBeUndefined();
    expect(tileQuad(c, 1, 0, 0)!.px).toEqual([100, 50, 512, 300]);
    expect(tileQuad(c, 1, 1, 0)!.px).toEqual([512, 50, 600, 300]);
    const all = tilesInView(c, IDENTITY_VIEW(4000, 4000, [1, 0, 0, 1, 0, 4000]), 1);
    expect(all).toEqual([{ col: 0, row: 0 }, { col: 1, row: 0 }]);
  });

  it("a coarser level maps its texels onto the same footprint: level 0 of 2 covers 2x the pixels per texel", () => {
    const p = placement({ width: 1000, height: 700, visibleBox: [0, 0, 1000, 700], levels: 2 });
    const q = tileQuad(p, 0, 0, 0)!;
    expect(q.px).toEqual([0, 0, 1000, 700]);
    expect(to12(q.uv[2])).toBe(to12(500 / 512));
    expect(to12(q.uv[3])).toBe(to12(350 / 512));
  });
});

describe("#102 the texture budget", () => {
  const MiB = 1024 * 1024;
  it("a 512 px RGBA tile is 1 MiB, so the default 128 MiB gpu tier holds 128 of them", () => {
    expect(tileTextureBytes(512)).toBe(MiB);
    expect(128 * MiB / tileTextureBytes(512)).toBe(128);
  });

  it("two rasters at 1:1 on a 4K view exceed 2 x 54 x 2 tiles, so a coarser level is drawn; with room they keep their level", () => {
    const mk = (id: number) => placement({ id, width: 16384, height: 16384, visibleBox: [0, 0, 16384, 16384], levels: 6 });
    const ps = [mk(0), mk(1)];
    const view = IDENTITY_VIEW(3840, 2160, [1, 0, 0, 1, 0, 2160]);
    const roomy = fitLevels(ps, view, 1024 * MiB);
    expect(roomy.map((r) => r.level)).toEqual(roomy.map((r) => r.wanted));
    expect(roomy.every((r) => r.level === 5)).toBe(true);
    const tight = fitLevels(ps, view, 128 * MiB);
    expect(tight.some((r) => r.level < r.wanted)).toBe(true);
    const bytes = tight.reduce((n, r) => n + r.tiles.length * 2 * tileTextureBytes(512), 0);
    expect(bytes).toBeLessThanOrEqual(128 * MiB);
    for (const r of tight) expect(r.tiles.length).toBeLessThanOrEqual(tileBound(3840, 2160, 512));
  });

  it("a placement that cannot fit even at its coarsest level still draws that level (one tile) and never loops", () => {
    const r = fitLevels([placement({ width: 600, height: 600, visibleBox: [0, 0, 600, 600], levels: 2 })], IDENTITY_VIEW(1920, 1080, [1, 0, 0, 1, 0, 600]), 1);
    expect(r[0]!.level).toBe(0);
  });

  it("the upload budget is respected across frames and always makes progress", () => {
    let t = 0;
    const queue = Array.from({ length: 10 }, (_, i) => ({ key: `t${i}`, bytes: tileTextureBytes(512) }));
    const frames: string[][] = [];
    while (queue.length) frames.push(takeUploads(queue, { budgetBytes: DEFAULTS.uploadBudgetBytes, budgetMs: DEFAULTS.uploadBudgetMs, now: () => t }).map((u) => u.key));
    expect(frames.map((f) => f.length)).toEqual([4, 4, 2]);
    expect(frames.flat()).toEqual(Array.from({ length: 10 }, (_, i) => `t${i}`));
    // the millisecond limit stops a frame too, but never before the first upload
    const slow = [{ key: "a", bytes: 1 }, { key: "b", bytes: 1 }];
    const clock = () => (t += budget(3));
    expect(takeUploads(slow, { budgetBytes: 1 << 30, budgetMs: DEFAULTS.uploadBudgetMs, now: clock }).map((u) => u.key)).toEqual(["a"]);
    expect(slow.map((u) => u.key)).toEqual(["b"]);
  });
});

describe("#102 order, diagnostics and attribution", () => {
  it("band 0 draws under the strokes and band 1 over them, by RasterId inside a band", () => {
    const ps = [placement({ id: 7, band: 1 }), placement({ id: 2, band: 0 }), placement({ id: 5, band: 1 }), placement({ id: 1, band: 0 })];
    const o = drawOrder(ps);
    expect(o.under.map((p) => p.id)).toEqual([1, 2]);
    expect(o.over.map((p) => p.id)).toEqual([5, 7]);
  });

  it("an unknown codec, or a JPEG with an alpha channel, is skipped and reported, the rest draws", () => {
    const r = classifyRasters([placement({ id: 0 }), placement({ id: 1, codec: 9 }), placement({ id: 2, codec: 2, channels: 4 }), placement({ id: 3, codec: 2, channels: 3 })]);
    expect(r.drawable.map((p) => p.id)).toEqual([0, 3]);
    expect(r.unrastered).toEqual([{ id: 1, reason: "unknown-codec" }, { id: 2, reason: "jpeg-with-alpha" }]);
  });

  it("attribution with markup is escaped before it reaches MapLibre's attribution control", () => {
    expect(escapeAttribution('<img src=x onerror=alert(1)> & "Plan" \'A\'')).toBe("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Plan&quot; &#39;A&#39;");
    expect(escapeAttribution("Stadt Zürich 2026")).toBe("Stadt Zürich 2026");
  });

  it("composition applies the right-hand map first", () => {
    expect(compose([2, 0, 0, 2, 0, 0], [1, 0, 0, 1, 3, 4])).toEqual([2, 0, 0, 2, 6, 8]);
  });
});
