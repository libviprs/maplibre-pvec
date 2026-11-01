import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Tier0Decoder } from "../../src/decode/tier0";
import { tier0CursorOver } from "../../src/layer/tier0-cursor";
import { loadEvaluator, type Evaluator } from "../../src/wasm/loader";
import { bindPacked } from "../../src/wasm/packed";
import { EVALUATOR_WASM_BYTES } from "./helpers/probe";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const file = new Uint8Array(readFileSync(join(root, "tests/fixtures/pvec-leaves", "leaf100.pvec")));

/** Every call of the module by name, in order, with its first argument; `open` also remembers the handle it returned. */
async function traced(): Promise<{ ev: Evaluator; log: string[]; fileHandle: () => number }> {
  const ev = await loadEvaluator({ wasmModule: await WebAssembly.compile(EVALUATOR_WASM_BYTES) });
  const log: string[] = [];
  let handle = -1;
  const exports = Object.fromEntries(
    Object.entries(ev.instance.exports as Record<string, unknown>).map(([k, v]) => [
      k,
      typeof v === "function"
        ? (...a: unknown[]) => {
            const r = (v as (...x: unknown[]) => unknown)(...a);
            if (k === "open") handle = r as number;
            log.push(k === "release" ? `release:${a[0] === handle ? "file" : "other"}` : k);
            return r;
          }
        : v,
    ]),
  );
  return { ev: { ...ev, instance: { exports } as unknown as WebAssembly.Instance }, log, fileHandle: () => handle };
}

function extent(ev: Evaluator): [number, number, number, number] {
  const rt = bindPacked(ev);
  const f = rt.open(file);
  const b = [0, 1, 2, 3].map((n) => rt.directoryBound(f, n)) as [number, number, number, number];
  rt.release(f);
  return b;
}

describe("#132 the file is not freed inside a decoder slice", () => {
  it("no slice of the decoder contains the release of the file handle (it costs 6 to 40 ms and grows with the file)", async () => {
    const { ev, log } = await traced();
    const ext = extent(ev);
    log.length = 0;
    const cursor = tier0CursorOver(ev, file, ext);
    const dec = new Tier0Decoder();
    const inSlice: string[] = [];
    for (;;) {
      const from = log.length;
      const s = dec.decodeSlice(cursor);
      inSlice.push(...log.slice(from).filter((c) => c === "release:file"));
      if (!s) break;
    }
    expect(inSlice, "release(file) calls made while a slice ran").toEqual([]);
  });

  it("the call that returns the end of the stream does not release the file", async () => {
    const { ev, log } = await traced();
    const ext = extent(ev);
    log.length = 0;
    const cursor = tier0CursorOver(ev, file, ext);
    let released = 0;
    for (let guard = 0; guard < 1e5; guard++) {
      const from = log.length;
      const batch = cursor.next(8);
      released = log.slice(from).filter((c) => c === "release:file").length;
      if (batch === null) break;
    }
    expect(released, "release(file) inside the next() that returned null").toBe(0);
  });

  it("the file is released exactly once after the walk has ended, and once when closed early (guards, green before the fix)", async () => {
    const a = await traced();
    const extA = extent(a.ev);
    a.log.length = 0;
    const full = tier0CursorOver(a.ev, file, extA);
    while (full.next(8) !== null);
    await new Promise((r) => setTimeout(r, 0));
    full.close();
    expect(a.log.filter((c) => c === "release:file")).toHaveLength(1);

    const b = await traced();
    const extB = extent(b.ev);
    b.log.length = 0;
    const early = tier0CursorOver(b.ev, file, extB);
    early.next(8);
    early.close();
    early.close();
    expect(b.log.filter((c) => c === "release:file")).toHaveLength(1);
  });
});
