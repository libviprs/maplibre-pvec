import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadEvaluator, type Evaluator } from "../../src/wasm/loader";
import { bindPacked } from "../../src/wasm/packed";
import { EVALUATOR_WASM_BYTES } from "./helpers/probe";

// M2.3: the headless evaluator suite and its five-mutation table. The suite is a list of named checks over the real module
// (the pinned pvec-wasm). A mutation is one change at the boundary between this package and the module, the kind a sign, a
// factor or a skipped step makes: it is applied to the module's exports, and the table says which checks go red. The
// suite is only worth anything if every mutation turns at least one check red and the module as shipped turns none.

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pvec = (id: string): Uint8Array => new Uint8Array(readFileSync(join(root, "tests/fixtures/pvec", `${id}.pvec`)));
const WORLD: [number, number, number, number] = [-1e9, -1e9, 1e9, 1e9];
// source_to_map identity, map_to_screen identity, pixel ratio 1, then the screen and world budgets (a drawing budget, not a numeric-policy tolerance).
const BUDGET = 0.01;
const chain = (world: number): number[] => [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1e9, world];
// circle-001 is centre (1.5, -2.25), radius 2.75 (its expected.math.json)
const CENTRE = [1.5, -2.25] as const;
const RADIUS = 2.75;

type Exports = Record<string, (...a: number[]) => number> & { memory: WebAssembly.Memory };
type Check = { name: string; run(ev: Evaluator): void };

const circle = (ev: Evaluator, precision: "f64" | "f32" = "f64") => {
  const rt = bindPacked(ev);
  const f = rt.open(pvec("circle-001"));
  const out = rt.tessellate(rt.queryViewport(f, ...WORLD, 10), chain(BUDGET), 100_000, precision);
  return { rt, f, out, v: rt.views(out) };
};

const CHECKS: Check[] = [
  {
    name: "the offset table brackets the vertices, one range per entity",
    run(ev) {
      const { v } = circle(ev);
      expect(v.offsets.length).toBe(v.entityIds.length + 1);
      expect(v.offsets[0]).toBe(0);
      expect(v.offsets[v.offsets.length - 1]).toBe(v.vertices.length / 2);
    },
  },
  {
    name: "vertices are the precision that was asked for",
    run(ev) {
      expect(circle(ev, "f64").v.vertices).toBeInstanceOf(Float64Array);
      expect(circle(ev, "f32").v.vertices).toBeInstanceOf(Float32Array);
    },
  },
  {
    name: "the vertices and the chords of a circle are within the asked world error of it",
    run(ev) {
      const { v } = circle(ev);
      const at = (i: number) => [v.vertices[2 * i]!, v.vertices[2 * i + 1]!] as const;
      const n = v.vertices.length / 2;
      for (let i = 0; i < n; i++) {
        expect(Math.abs(Math.hypot(at(i)[0] - CENTRE[0], at(i)[1] - CENTRE[1]) - RADIUS)).toBeLessThanOrEqual(BUDGET);
      }
      // and it goes all the way round: the extent of the polyline is the diameter of the circle, less the error
      const xs = Array.from({ length: n }, (_, i) => at(i)[0]);
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThanOrEqual(2 * RADIUS - 2 * BUDGET);
      for (let i = 0; i + 1 < n; i++) {
        const mx = (at(i)[0] + at(i + 1)[0]) / 2, my = (at(i)[1] + at(i + 1)[1]) / 2;
        expect(RADIUS - Math.hypot(mx - CENTRE[0], my - CENTRE[1])).toBeLessThanOrEqual(BUDGET);
      }
    },
  },
  {
    name: "a released handle is refused afterwards",
    run(ev) {
      const { rt, f, out } = circle(ev);
      expect(rt.release(out)).toBe(0);
      expect(rt.release(f)).toBe(0);
      expect(rt.release(f)).toBe(-1);
      expect(rt.queryViewport(f, ...WORLD, 10)).toBeLessThan(0);
    },
  },
  {
    name: "a viewport query keeps the entities that meet the window and only those",
    run(ev) {
      const rt = bindPacked(ev);
      const f = rt.open(pvec("polyline-001"));
      const all = rt.batchLength(rt.queryViewport(f, ...WORLD, 1000));
      const none = rt.batchLength(rt.queryViewport(f, 1e8, 1e8, 2e8, 2e8, 1000));
      expect(all).toBeGreaterThan(0);
      expect(none).toBe(0);
    },
  },
];

/** The module with some exports replaced by a function of the real one. */
function mutated(real: Evaluator, replace: (x: Exports) => Record<string, (...a: number[]) => number>): Evaluator {
  const x = real.instance.exports as unknown as Exports;
  const exports = { ...x, ...replace(x) };
  return { ...real, instance: { exports } as unknown as WebAssembly.Instance };
}

const MUTATIONS: Array<{ id: string; what: string; apply(real: Evaluator): Evaluator }> = [
  {
    id: "M1",
    what: "the offset table starts one element late (a pointer off by one element)",
    apply: (real) => mutated(real, (x) => ({ buffer_ptr: (r, w) => x.buffer_ptr!(r, w) + (w === 1 ? 4 : 0) })),
  },
  {
    id: "M2",
    what: "the precision flag is inverted (f64 asked, f32 made, and the other way round)",
    apply: (real) => mutated(real, (x) => ({ tessellate_batch: (b, p, l, m, prec) => x.tessellate_batch!(b, p, l, m, prec === 0 ? 1 : 0) })),
  },
  {
    id: "M3",
    what: "the world error budget is a thousand times too loose (a factor)",
    apply: (real) => mutated(real, (x) => ({
      tessellate_batch: (b, p, l, m, prec) => {
        const mem = new Float64Array(x.memory.buffer, p, l);
        mem[14] = mem[14]! * 1000;
        return x.tessellate_batch!(b, p, l, m, prec);
      },
    })),
  },
  {
    id: "M4",
    what: "release does nothing (a skipped step: the handle lives on)",
    apply: (real) => mutated(real, () => ({ release: () => 0 })),
  },
  {
    id: "M5",
    what: "the viewport's corners are swapped (a sign): the window is empty for the module",
    apply: (real) => mutated(real, (x) => ({ query_viewport: (f, x0, y0, x1, y1, b) => x.query_viewport!(f, x1, y1, x0, y0, b) })),
  },
];

async function evaluator(): Promise<Evaluator> {
  return loadEvaluator({ wasmModule: await WebAssembly.compile(EVALUATOR_WASM_BYTES) });
}

/** The names of the checks that fail against `ev`. */
function red(ev: Evaluator): string[] {
  const out: string[] = [];
  for (const c of CHECKS) {
    try {
      c.run(ev);
    } catch {
      out.push(c.name);
    }
  }
  return out;
}

describe("M2.3 the evaluator suite and its five-mutation table", () => {
  it("the module as shipped passes every check", async () => {
    expect(red(await evaluator())).toEqual([]);
  });

  it("there are five mutations and five or more checks", () => {
    expect(MUTATIONS).toHaveLength(5);
    expect(CHECKS.length).toBeGreaterThanOrEqual(5);
  });

  for (const m of MUTATIONS) {
    it(`${m.id} ${m.what}: at least one check goes red`, async () => {
      const failing = red(m.apply(await evaluator()));
      expect(failing, `no check noticed ${m.id}`).not.toEqual([]);
    });
  }

  it("every check is the one that catches some mutation (no check is dead weight)", async () => {
    const real = await evaluator();
    const caught = new Set<string>();
    for (const m of MUTATIONS) for (const name of red(m.apply(real))) caught.add(name);
    expect([...caught].sort()).toEqual(CHECKS.map((c) => c.name).sort());
  });
});
