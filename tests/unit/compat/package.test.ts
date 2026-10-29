import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

describe("#31 M7.6 package.json", () => {
  it("is ESM only with no side effects and zero runtime dependencies", () => {
    expect(pkg.type).toBe("module");
    expect(pkg.sideEffects).toBe(false);
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(Object.keys(pkg.peerDependencies)).toEqual(["maplibre-gl"]);
    expect(pkg.scripts.postinstall).toBeUndefined();
    expect(pkg.scripts.install).toBeUndefined();
    expect(pkg.scripts.preinstall).toBeUndefined();
  });

  it("exports the five subpaths, each with types first and an import condition only", () => {
    expect(Object.keys(pkg.exports).sort()).toEqual([".", "./hatch", "./package.json", "./style", "./text", "./wasm", "./wasm/pvec_eval.wasm"].sort());
    for (const k of [".", "./style", "./text", "./hatch", "./wasm"]) {
      expect(Object.keys(pkg.exports[k])).toEqual(["types", "import"]);
    }
  });

  it("ships the wasm asset and types in files and nothing from the dev tree", () => {
    expect(pkg.files).toEqual(["dist", "LICENSE", "README.md"]);
  });
});
