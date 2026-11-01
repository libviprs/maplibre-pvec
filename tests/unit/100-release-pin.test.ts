import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pin = JSON.parse(readFileSync("wasm/pvec.pin.json", "utf8")) as {
  pvecCommit: string;
  abiVersion: number;
  wasm: { bytes: number; sha256: string };
  release?: { commit: string; abiVersion: number };
};

// The published libviprs/pvec release wasm-v1-fc5ca4a, which carries the raster exports the adapter calls (pvec#202) and the per-leaf calls the Tier 0 cursor walks (pvec#238).
const RELEASE = {
  commit: "fc5ca4a6cf59eff6339ed11d0931eec81d7feb30",
  bytes: 751260,
  sha256: "38124ae55169cc0cc352d967f85c82d0250e4ca145df4953681f0e2a329545ca",
};

describe("#100 the evaluator is the published pvec release", () => {
  it("pins the release commit and its digest", () => {
    expect(pin.pvecCommit).toBe(RELEASE.commit);
    expect(pin.release?.commit).toBe(RELEASE.commit);
    expect(pin.release?.abiVersion).toBe(2);
    expect(pin.wasm.bytes).toBe(RELEASE.bytes);
    expect(pin.wasm.sha256).toBe(RELEASE.sha256);
  });
});
