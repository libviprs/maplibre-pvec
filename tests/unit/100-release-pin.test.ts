import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pin = JSON.parse(readFileSync("wasm/pvec.pin.json", "utf8")) as {
  pvecCommit: string;
  abiVersion: number;
  wasm: { bytes: number; sha256: string };
  release?: { commit: string; abiVersion: number };
};

// The published libviprs/pvec release wasm-v1-232f876, which carries the raster exports the adapter calls (pvec#202), the per-leaf calls the Tier 0 cursor walks (pvec#238) and the exact distance exports the query engine calls (pvec#252).
const RELEASE = {
  commit: "232f876b1ae42713d3bf1870c09edd86f6ae00b0",
  bytes: 798522,
  sha256: "dfb76d3fca7acfb04b1b8dfbb5f5159d2b3c5651d8a09629ad30551cc320deeb",
};

describe("#100 the evaluator is the published pvec release", () => {
  it("pins the release commit and its digest", () => {
    expect(pin.pvecCommit).toBe(RELEASE.commit);
    expect(pin.release?.commit).toBe(RELEASE.commit);
    expect(pin.release?.abiVersion).toBe(2);
    expect(pin.wasm.bytes).toBe(RELEASE.bytes);
    expect(pin.wasm.sha256).toBe(RELEASE.sha256);
  });

  it("the module in wasm/ exports the two distance functions and keeps every export it had", async () => {
    const module = await WebAssembly.compile(readFileSync("wasm/pvec_eval.wasm"));
    const names = WebAssembly.Module.exports(module).map((e) => e.name);
    expect(names).toContain("entity_distance");
    expect(names).toContain("entity_touches_box");
    // the 50 exports of wasm-v1-dcef7f6 are all still there: the release is additive
    expect(names.length).toBe(52);
    for (const old of ["tier0_leaf", "query_leaf", "raster_plan", "tessellate_batch", "directory_query", "wasm_abi_version"]) expect(names).toContain(old);
  });
});
