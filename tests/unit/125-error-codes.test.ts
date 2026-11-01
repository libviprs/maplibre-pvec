import { describe, expect, it } from "vitest";
import type { Evaluator } from "../../src/wasm/loader";
import { bindPacked } from "../../src/wasm/packed";

const evaluator = (exports: Record<string, unknown>): Evaluator => ({ instance: { exports } as unknown as WebAssembly.Instance, abiVersion: 2, source: "injected" } as unknown as Evaluator);

describe("#125 the ABI's error codes are not mistaken for a handle", () => {
  it("returns every code from -1 to -11 as the code it is (-11: a batch past the vertex bound, pvec#236)", () => {
    for (let code = -1; code >= -11; code--) {
      const rt = bindPacked(evaluator({ tessellate_batch: () => code, __wbindgen_malloc: () => 0, memory: new WebAssembly.Memory({ initial: 1 }) }));
      expect(rt.tessellate(1, [], 1, "f64"), `code ${code}`).toBe(code);
    }
  });

  it("still returns a handle whose generation has grown into the sign bit as the unsigned number it is", () => {
    const rt = bindPacked(evaluator({ tessellate_batch: () => -2147483646, __wbindgen_malloc: () => 0, memory: new WebAssembly.Memory({ initial: 1 }) }));
    expect(rt.tessellate(1, [], 1, "f64")).toBe(2147483650);
  });
});
