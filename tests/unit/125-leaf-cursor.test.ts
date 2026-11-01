import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Tier0Decoder, type RawEntity } from "../../src/decode/tier0";
import { tier0CursorOver } from "../../src/layer/tier0-cursor";
import { loadEvaluator, type Evaluator } from "../../src/wasm/loader";
import { bindPacked } from "../../src/wasm/packed";
import { EVALUATOR_WASM_BYTES } from "./helpers/probe";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const bytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(root, "tests/fixtures/pvec-leaves", `${name}.pvec`)));
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

// pathological-1e3 (917 entities with a spatial directory and Tier 0 blocks) written by pvec's own writer with a leaf capacity of 100
// and of 1000 (tools/pvec-emit-large.rs, LEAF=100 and LEAF=1000), so the same entities are eight leaves in one file and one leaf in the other.
const FILES = { leaf100: { leaves: 8 }, leaf1000: { leaves: 1 } } as const;

async function evaluator(hide: readonly string[] = []): Promise<Evaluator> {
  const ev = await loadEvaluator({ wasmModule: await WebAssembly.compile(EVALUATOR_WASM_BYTES) });
  if (!hide.length) return ev;
  const exports = Object.fromEntries(Object.entries(ev.instance.exports as Record<string, unknown>).filter(([k]) => !hide.includes(k)));
  return { ...ev, instance: { exports } as unknown as WebAssembly.Instance };
}

/** Wraps the exports of an evaluator so that every call by name is counted. */
async function counted(): Promise<{ ev: Evaluator; calls: Record<string, number> }> {
  const ev = await evaluator();
  const calls: Record<string, number> = {};
  const exports = Object.fromEntries(
    Object.entries(ev.instance.exports as Record<string, unknown>).map(([k, v]) => [k, typeof v === "function" ? (...a: unknown[]) => ((calls[k] = (calls[k] ?? 0) + 1), (v as (...x: unknown[]) => unknown)(...a)) : v]),
  );
  return { ev: { ...ev, instance: { exports } as unknown as WebAssembly.Instance }, calls };
}

/** Every entity id of the file and the box of its coarse tessellation, from the whole-file batch: the truth the cursor is held to. */
function truth(ev: Evaluator, file: Uint8Array): Map<number, [number, number, number, number]> {
  const rt = bindPacked(ev);
  const f = rt.open(file);
  const batch = rt.queryViewport(f, -1e9, -1e9, 1e9, 1e9, 1e7);
  const t = rt.tessellate(batch, [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1e9, 1e-2], 5e6, "f64");
  const v = rt.views(t);
  const out = new Map<number, [number, number, number, number]>();
  for (let i = 0; i < v.entityIds.length; i++) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 2 * v.offsets[i]!; k < 2 * v.offsets[i + 1]!; k += 2) {
      x0 = Math.min(x0, v.vertices[k]!); x1 = Math.max(x1, v.vertices[k]!);
      y0 = Math.min(y0, v.vertices[k + 1]!); y1 = Math.max(y1, v.vertices[k + 1]!);
    }
    out.set(v.entityIds[i]!, [x0, y0, x1, y1]);
  }
  rt.release(t); rt.release(batch); rt.release(f);
  return out;
}

function extent(ev: Evaluator, file: Uint8Array): [number, number, number, number] {
  const rt = bindPacked(ev);
  const f = rt.open(file);
  const b = [0, 1, 2, 3].map((n) => rt.directoryBound(f, n)) as [number, number, number, number];
  rt.release(f);
  return b;
}

/** The entities of `want` the cursor did not return are the ones smaller than a pixel of its 1920 pixel view, which it drops. */
function expectAllButPixelSized(got: Set<number>, want: Map<number, [number, number, number, number]>, ext: [number, number, number, number]): void {
  const px = Math.max(ext[2] - ext[0], ext[3] - ext[1]) / 1920;
  for (const id of got) expect(want.has(id), `entity ${id} is in the file`).toBe(true);
  for (const [id, b] of want) {
    if (!got.has(id)) expect(Math.max(b[2] - b[0], b[3] - b[1]), `entity ${id} was dropped`).toBeLessThanOrEqual(2 * px);
  }
}

function leafInfo(ev: Evaluator, file: Uint8Array): { leaves: number; withBlock: number } {
  const rt = bindPacked(ev);
  const f = rt.open(file);
  const q = rt.directoryQuery(f, -1e9, -1e9, 1e9, 1e9);
  if (typeof q === "number") throw new Error(`directory_query ${q}`);
  const out = { leaves: q.cells.length, withBlock: Array.from(q.hasTier0).filter((v) => v === 1).length };
  rt.release(q.handle); rt.release(f);
  return out;
}

function drain(cursor: ReturnType<typeof tier0CursorOver>): { all: RawEntity[]; blocks: number } {
  const all: RawEntity[] = [];
  let blocks = 0;
  for (let s = cursor.next(8); s !== null; s = cursor.next(8)) {
    all.push(...s);
    if (cursor.endsBlock?.()) blocks++;
  }
  return { all, blocks };
}

describe("#125 the fixtures are the bytes pvec's writer made", () => {
  it("are pinned by digest", () => {
    expect(sha(bytes("leaf100"))).toBe("8cc81583a552db6b94936d7c23152966d14b7c3246e09639151fa7e8f321a87f");
    expect(sha(bytes("leaf1000"))).toBe("fc2547cf74f2a3f51bab2fd0c60188307d3fedb7020d54175a118b83de853cc8");
  });
});

describe("#125 the default cursor walks leaves, and a leaf is a block", () => {
  it("answers every entity once, and ends a block for each leaf and for the advanced curves", async () => {
    const ev = await evaluator();
    const want = truth(ev, bytes("leaf100"));
    const { all, blocks } = drain(tier0CursorOver(ev, bytes("leaf100"), extent(ev, bytes("leaf100"))));
    const ids = all.map((e) => Number(e.entityId));
    expect(new Set(ids).size, "no entity twice").toBe(ids.length);
    expectAllButPixelSized(new Set(ids), want, extent(ev, bytes("leaf100")));
    // the eight leaves, and one more block if the file has advanced curves
    expect(leafInfo(ev, bytes("leaf100")).leaves).toBe(FILES.leaf100.leaves);
    expect(blocks).toBeGreaterThanOrEqual(FILES.leaf100.leaves);
    expect(blocks).toBeLessThanOrEqual(FILES.leaf100.leaves + 1);
  });

  it("never asks the module for a window: the calls are the per-leaf ones", async () => {
    const { ev, calls } = await counted();
    drain(tier0CursorOver(ev, bytes("leaf100"), extent(ev, bytes("leaf100"))));
    expect(calls["tier0_viewport"] ?? 0).toBe(0);
    expect(calls["query_viewport"] ?? 0).toBe(0);
    expect(calls["tier0_leaf"], "one for each leaf that has a Tier 0 block").toBe(leafInfo(ev, bytes("leaf100")).withBlock);
    expect(calls["query_leaf"]).toBeGreaterThanOrEqual(FILES.leaf100.leaves);
  });

  it("tessellates each entity once: the module is asked for no more entities than the file holds, with the previews' share", async () => {
    const { ev, calls } = await counted();
    const n = truth(ev, bytes("leaf100")).size;
    const before = calls["tessellate_batch"] ?? 0;
    drain(tier0CursorOver(ev, bytes("leaf100"), extent(ev, bytes("leaf100"))));
    const pages = (calls["tessellate_batch"] ?? 0) - before;
    // pages of at most 256 entities (32 for the advanced curves): eight leaves of about a hundred, plus the advanced ones
    expect(pages).toBeLessThanOrEqual(FILES.leaf100.leaves + Math.ceil(n / 32));
  });

  it("a window answers the entities that meet it and no others", async () => {
    const ev = await evaluator();
    const file = bytes("leaf100");
    const want = truth(ev, file);
    const e = extent(ev, file);
    const w: [number, number, number, number] = [e[0], e[1], e[0] + (e[2] - e[0]) / 3, e[1] + (e[3] - e[1]) / 3];
    const { all } = drain(tier0CursorOver(ev, file, w));
    const got = new Set(all.map((x) => Number(x.entityId)));
    const meets = (b: number[]) => b[0]! <= w[2] && b[2]! >= w[0] && b[1]! <= w[3] && b[3]! >= w[1];
    for (const [id, b] of want) {
      if (b.every((v) => Number.isFinite(v)) && meets(b)) expect(got.has(id), `entity ${id} meets the window`).toBe(true);
    }
    for (const x of all) expect(meets([x.bounds.minX, x.bounds.minY, x.bounds.maxX, x.bounds.maxY]), `entity ${x.entityId}`).toBe(true);
    expect(got.size).toBeLessThan(want.size);
  });
});

describe("#125 the hostile-input limit is per block and was not raised", () => {
  it("a file of eight leaves passes a limit that its whole is over", async () => {
    const ev = await evaluator();
    const file = bytes("leaf100");
    const cursor = tier0CursorOver(ev, file, extent(ev, file));
    const draws = new Tier0Decoder({ maxEntitiesPerBlock: 300, maxSliceMs: 8 }).decodeAll(cursor);
    expect(draws.length).toBeGreaterThan(300);
  });

  it("the same entities in one leaf are one block over that limit and are refused", async () => {
    const ev = await evaluator();
    const file = bytes("leaf1000");
    const cursor = tier0CursorOver(ev, file, extent(ev, file));
    expect(() => new Tier0Decoder({ maxEntitiesPerBlock: 300, maxSliceMs: 8 }).decodeAll(cursor)).toThrow(/maxEntitiesPerBlock/);
    cursor.close();
  });

  it("the default is still 200,000", async () => {
    const { DEFAULTS } = await import("../../src/config/defaults");
    expect(DEFAULTS.maxEntitiesPerBlock).toBe(200_000);
  });
});

describe("#125 a module without the per-leaf calls keeps the box walk", () => {
  it("answers the same entities, as one block", async () => {
    const ev = await evaluator(["tier0_leaf", "query_leaf"]);
    const file = bytes("leaf100");
    const want = truth(await evaluator(), file);
    const { all, blocks } = drain(tier0CursorOver(ev, file, extent(ev, file)));
    expectAllButPixelSized(new Set(all.map((e) => Number(e.entityId))), want, extent(ev, file));
    expect(blocks).toBe(1);
  });
});
