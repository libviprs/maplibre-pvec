import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { findConverterReferences, findExternalHosts, findToleranceLiterals } from "../conformance/guards";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "results" || n === ".cache") return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(join(root, "bench")).filter((f) => /\.(ts|mjs|json|md|html)$/.test(f));

describe("#34 nothing under bench/ breaks the rules", () => {
  it("has files to scan", () => expect(files.length).toBeGreaterThan(5));
  it("references no proprietary converter, SDK path or licence key", () => {
    const hits = files.flatMap((f) => findConverterReferences(relative(root, f), readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
    const keys = files.filter((f) => /licen[cs]e[_-]?key\s*[:=]\s*["'][^"']+/i.test(readFileSync(f, "utf8")));
    expect(keys).toEqual([]);
  });
  it("declares no mathematical epsilon", () => {
    const hits = files
      .filter((f) => f.endsWith(".ts") || f.endsWith(".mjs"))
      .flatMap((f) => findToleranceLiterals(relative(root, f), readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
  it("names no host other than loopback", () => {
    const hosts = files
      .filter((f) => !f.endsWith("corpus.schema.json"))
      .flatMap((f) => findExternalHosts(f, readFileSync(f, "utf8"), ["127.0.0.1", "localhost"]));
    expect(hosts).toEqual([]);
  });
});
