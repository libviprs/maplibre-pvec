import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pin = JSON.parse(readFileSync("wasm/pvec.pin.json", "utf8")) as {
  pvecCommit: string;
  abiVersion: number;
  wasm: { bytes: number; sha256: string };
  release?: { commit: string; abiVersion: number };
};

// The published libviprs/pvec release wasm-v1-c4f71b3, which carries the raster exports the adapter calls (pvec#202) and the per-leaf calls the Tier 0 cursor walks (pvec#238).
const RELEASE = {
  commit: "c4f71b39324ef6d78de1731ac51a4ad49b01fd8e",
  bytes: 750956,
  sha256: "c73c94595c00f106071c458442d08fafa68031456ef70695f93e619ed8a029eb",
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
