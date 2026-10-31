import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pin = JSON.parse(readFileSync("wasm/pvec.pin.json", "utf8")) as {
  pvecCommit: string;
  abiVersion: number;
  wasm: { bytes: number; sha256: string };
  release?: { commit: string; abiVersion: number };
};

// The published libviprs/pvec release wasm-v1-6ff0cf9 (part of libviprs/pvec#202).
const RELEASE = {
  commit: "6ff0cf913dfabdd04d36051ff8815111307c438b",
  bytes: 625716,
  sha256: "c7b83d7579edb047eba5dc2cbe4c022a8af8fdda1b0445de570e595174e93f74",
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
