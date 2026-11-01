import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pin = JSON.parse(readFileSync("wasm/pvec.pin.json", "utf8")) as {
  pvecCommit: string;
  abiVersion: number;
  wasm: { bytes: number; sha256: string };
  release?: { commit: string; abiVersion: number };
};

// The published libviprs/pvec release wasm-v1-dcef7f6, which carries the raster exports the adapter calls (pvec#202) and the per-leaf calls the Tier 0 cursor walks (pvec#238).
const RELEASE = {
  commit: "dcef7f6ad8c20be9d6b5053e93fda18b3566182f",
  bytes: 764921,
  sha256: "23c91e47c2739e775f9baa43e9a5252f788b0b6f32ac42028ca176943da7694e",
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
