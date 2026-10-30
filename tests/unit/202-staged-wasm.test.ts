import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveStagedWasm } from "../../tools/staged-wasm.mjs";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function stage(over: { abiVersion?: number; sha256?: string; bytes?: Buffer } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "staged-wasm-"));
  dirs.push(dir);
  const wasm = over.bytes ?? Buffer.from("\0asm-not-really");
  writeFileSync(path.join(dir, "pvec_wasm_bg.wasm"), wasm);
  const sha256 = createHash("sha256").update(wasm).digest("hex");
  writeFileSync(path.join(dir, "pvec-wasm-manifest.json"), JSON.stringify({
    schema: 1, commit: "ab".repeat(20), abiVersion: over.abiVersion ?? 1,
    wasm: { file: "pvec_wasm_bg.wasm", bytes: wasm.length, sha256: over.sha256 ?? sha256 },
  }));
  return { dir, sha256 };
}

describe("a staged pvec-wasm release directory (issue 202)", () => {
  it("resolves a directory and a file inside it to the same verified module", () => {
    const { dir, sha256 } = stage();
    const a = resolveStagedWasm(dir, { abiVersion: 1 });
    const b = resolveStagedWasm(path.join(dir, "pvec_wasm_bg.wasm"), { abiVersion: 1 });
    expect(a).toMatchObject({ file: path.join(dir, "pvec_wasm_bg.wasm"), sha256, abiVersion: 1, verified: true });
    expect(b.file).toBe(a.file);
  });
  it("refuses a module whose digest differs from the manifest", () => {
    const { dir } = stage({ sha256: "0".repeat(64) });
    expect(() => resolveStagedWasm(dir, { abiVersion: 1 })).toThrow(/sha256/);
  });
  it("refuses an ABI version the package does not know", () => {
    const { dir } = stage({ abiVersion: 2 });
    expect(() => resolveStagedWasm(dir, { abiVersion: 1 })).toThrow(/ABI/);
  });
  it("refuses a digest that differs from the one the caller pinned", () => {
    const { dir } = stage();
    expect(() => resolveStagedWasm(dir, { abiVersion: 1, sha256: "f".repeat(64) })).toThrow(/sha256/);
  });
  it("takes a bare file with no manifest as an unverified local build", () => {
    const lone = mkdtempSync(path.join(tmpdir(), "staged-wasm-"));
    dirs.push(lone);
    writeFileSync(path.join(lone, "x.wasm"), "abc");
    expect(resolveStagedWasm(path.join(lone, "x.wasm"), { abiVersion: 1 }).verified).toBe(false);
  });
  it("refuses a directory with no manifest", () => {
    const d = mkdtempSync(path.join(tmpdir(), "staged-wasm-"));
    dirs.push(d);
    expect(() => resolveStagedWasm(d, { abiVersion: 1 })).toThrow(/manifest/);
  });
});
