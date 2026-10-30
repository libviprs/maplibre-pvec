import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ES module without declarations
import { wiredLayerEvidence } from "../../../tools/release-gate.mjs";

const real = path.resolve("release/evidence/83-wired-layer.json");
const good = () => JSON.parse(readFileSync(real, "utf8"));
const rootWith = (e: unknown) => {
  const root = mkdtempSync(path.join(tmpdir(), "ev83-"));
  mkdirSync(path.join(root, "release/evidence"), { recursive: true });
  writeFileSync(path.join(root, "release/evidence/83-wired-layer.json"), JSON.stringify(e));
  return root;
};

describe("#83 the freeze conditions follow the measured run", () => {
  it("the committed evidence supports both conditions", () => {
    const r = wiredLayerEvidence(path.resolve("."));
    expect(r.wasmOk).toBe(true);
    expect(r.lossOk).toBe(true);
  });
  it("no evidence file means neither condition is met", () => {
    const r = wiredLayerEvidence(mkdtempSync(path.join(tmpdir(), "ev83-")));
    expect([r.wasmOk, r.lossOk]).toEqual([false, false]);
  });
  it("a range request before the evaluator was known good fails the WASM condition", () => {
    const e = good();
    e.wasmBlocked.rangeRequests = 1;
    expect(wiredLayerEvidence(rootWith(e)).wasmOk).toBe(false);
  });
  it("two error events fail the WASM condition", () => {
    const e = good();
    e.wasmBlocked.errorEvents = 2;
    expect(wiredLayerEvidence(rootWith(e)).wasmOk).toBe(false);
  });
  it("a new range request after the restore fails the context-loss condition", () => {
    const e = good();
    e.contextLoss.newRangeRequests = 1;
    expect(wiredLayerEvidence(rootWith(e)).lossOk).toBe(false);
  });
  it("a snapshot that moved by more than 0.1 percent fails the context-loss condition", () => {
    const e = good();
    e.coexistence.outsideStrokeDiff = 0.01;
    expect(wiredLayerEvidence(rootWith(e)).lossOk).toBe(false);
  });
  it("state left behind in a frame fails the context-loss condition", () => {
    const e = good();
    e.coexistence.stateDiffs = 1;
    expect(wiredLayerEvidence(rootWith(e)).lossOk).toBe(false);
  });
});
