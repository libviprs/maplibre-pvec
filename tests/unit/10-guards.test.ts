import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findConverterReferences,
  findExternalHosts,
  findStepParsing,
  findToleranceLiterals,
} from "../conformance/guards";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function walk(dir: string, skip: RegExp, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const rel = relative(root, p);
    if (skip.test(rel)) continue;
    if (statSync(p).isDirectory()) walk(p, skip, out);
    else out.push(rel);
  }
  return out;
}
const skip = /(^|\/)(node_modules|dist|test-results|playwright-report|\.cache|corpus)(\/|$)/;
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

describe("#10 no proprietary converter in this repository", () => {
  it("flags a CAD Exchanger or ODA image reference", () => {
    const cad = ["cad", "exchanger"].join("");
    expect(findConverterReferences("a.sh", `docker pull registry/${cad}:1`)).toHaveLength(1);
    expect(findConverterReferences("a.sh", `FROM ${["Open", "Design"].join("")}/oda-converter`)).toHaveLength(1);
    expect(findConverterReferences("a.sh", "docker pull node:22")).toHaveLength(0);
  });

  it("finds none in scripts, workflows, Dockerfiles or package.json", () => {
    const files = [
      ...walk(join(root, "tools"), skip),
      ...walk(join(root, ".github"), skip),
      "package.json",
      "playwright.config.ts",
      ...walk(root, skip).filter((f) => /(^|\/)Dockerfile/.test(f)),
    ].filter((f) => !/guards\.(test\.)?ts$/.test(f));
    const hits = files.flatMap((f) => findConverterReferences(f, read(f)));
    expect(hits).toEqual([]);
  });
});

describe("#10 no STEP parsing", () => {
  it("flags STEP text handling", () => {
    expect(findStepParsing("x.ts", "if (l.startsWith('ISO-10303-21'))")).toHaveLength(1);
    expect(findStepParsing("x.ts", "const m = /CARTESIAN_POINT\\(/")).toHaveLength(1);
  });

  it("finds none under src or tests", () => {
    const files = [...walk(join(root, "src"), skip), ...walk(join(root, "tests"), skip)].filter(
      (f) => /\.(ts|mjs|js)$/.test(f) && !/guards\.(test\.)?ts$/.test(f),
    );
    expect(files.flatMap((f) => findStepParsing(f, read(f)))).toEqual([]);
  });
});

describe("#10 no tolerance literal outside the policy access point", () => {
  it("flags a literal used as a tolerance", () => {
    expect(findToleranceLiterals("t.ts", "expect(d).toBeLessThan(1e-6);")).toHaveLength(1);
    expect(findToleranceLiterals("t.ts", "expect(a).toBeCloseTo(b, 1e-9)")).toHaveLength(1);
    expect(findToleranceLiterals("t.ts", "const epsilon = 0.000001;")).toHaveLength(1);
    expect(findToleranceLiterals("t.ts", "const tol = 1e-12")).toHaveLength(1);
    expect(findToleranceLiterals("t.ts", "function cmp(a: number, b: number, eps: number) {}")).toHaveLength(1);
    expect(findToleranceLiterals("t.ts", "expect(n).toBe(3); const x = 0.5;")).toHaveLength(0);
  });

  it("finds none under tests or src outside the access point", () => {
    const files = [...walk(join(root, "tests"), skip), ...walk(join(root, "src"), skip)].filter(
      (f) => /\.ts$/.test(f) && !/guards\.(test\.)?ts$/.test(f) && !/tests\/policy\/access\.ts$/.test(f),
    );
    expect(files.flatMap((f) => findToleranceLiterals(f, read(f)))).toEqual([]);
  });
});

describe("#10 no external host", () => {
  const allowed = ["localhost", "127.0.0.1"];
  it("flags a non-local URL", () => {
    expect(findExternalHosts("s.ts", "await page.goto('https://example.com/x')", allowed)).toEqual(["example.com"]);
    expect(findExternalHosts("s.ts", "http://127.0.0.1:4173/a", allowed)).toEqual([]);
  });

  it("finds none in the browser specs or the origin script", () => {
    const files = [...walk(join(root, "tests", "e2e"), skip), "tools/fixture-origin.mjs"].filter((f) => existsSync(join(root, f)));
    expect(files.flatMap((f) => findExternalHosts(f, read(f), allowed))).toEqual([]);
  });
});
