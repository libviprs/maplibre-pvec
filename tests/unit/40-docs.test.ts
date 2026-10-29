import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PAGES, generateDocs, listDocPages } from "../../tools/docs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

describe("#40 documentation set", () => {
  const generated = generateDocs(root) as Map<string, string>;

  it("regenerates with no diff, so a hand edit of a generated page fails", () => {
    expect(generated.size).toBeGreaterThanOrEqual(4);
    for (const [file, text] of generated) expect(read(file), file).toBe(text);
  });

  it("has every page the plan names, and each is reachable from docs/README.md", () => {
    const index = read("docs/README.md");
    for (const want of [
      "architecture", "installation", "maplibre-custom-layer-contract", "pvec-semantic-reuse", "tier0-refinement-lifecycle",
      "stroke-rendering", "security-resource-limits", "slo", "range-cache-model", "georeferencing", "projection-capability",
      "precision", "buffer-model", "query-api", "wasm-worker-deployment", "benchmark-report", "compatibility", "v1-readiness", "deferred",
    ]) {
      const page = PAGES.find((p: { path: string }) => p.path === `${want}.md`);
      expect(page, want).toBeDefined();
      expect(index).toContain(`](${want}.md)`);
    }
    expect(index).toContain("](adr/webgpu-deferral.md)");
    expect(index).toContain("](api/reference.md)");
    expect(index).toContain("](../examples/README.md)");
  });

  it("fails on a missing or orphaned page", () => {
    const onDisk = listDocPages(root) as string[];
    const indexed = new Set(read("docs/README.md").match(/\]\(([^)#]+\.md)\)/g)!.map((m) => m.slice(2, -1)));
    for (const f of onDisk) if (f !== "README.md") expect(indexed.has(f), `orphan ${f}`).toBe(true);
    for (const l of indexed) if (!l.startsWith("../")) expect(onDisk.includes(l), `missing ${l}`).toBe(true);
  });

  it("has one page per subject", () => {
    const subjects = PAGES.map((p: { subject: string }) => p.subject);
    expect(new Set(subjects).size).toBe(subjects.length);
  });

  it("has no dead internal links", () => {
    const files = (listDocPages(root) as string[]).map((f) => `docs/${f}`);
    for (const f of files) {
      for (const m of read(f).matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1]!;
        if (/^[a-z]+:/.test(target) || target.startsWith("#")) continue;
        const p = path.normalize(path.join(root, path.dirname(f), target.split("#")[0]!));
        expect(() => statSync(p), `${f} -> ${target}`).not.toThrow();
      }
    }
  });

  it("references no origin other than localhost in code samples", () => {
    for (const f of listDocPages(root) as string[]) {
      for (const block of read(`docs/${f}`).matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
        for (const u of block[1]!.matchAll(/https?:\/\/([^/\s'"`:]+)/g)) {
          expect(["localhost", "127.0.0.1", "example.invalid"], `${f}: ${u[0]}`).toContain(u[1]);
        }
      }
    }
  });

  it("never calls a display-fidelity result exact, and states no mathematical tolerance", () => {
    for (const f of listDocPages(root) as string[]) {
      if (f.startsWith("spikes/") || f === "deferred.md") continue;
      // A sentence that denies the claim ("never called exact") is not the claim.
      const text = read(`docs/${f}`).split(/(?<=[.!?])\s+/).filter((x) => !/\b(not|never|nothing|no|neither)\b/i.test(x)).join(" ");
      expect(text, f).not.toMatch(/(mathematically|geometrically) exact/i);
      expect(text, f).not.toMatch(/tolerance of \d|within \d[\d.e-]* (mm|units?) of the (true|exact)/i);
    }
  });

  it("documents only symbols the package exports", () => {
    const ref = read("docs/api/reference.md");
    const index = read("src/index.ts");
    for (const m of ref.matchAll(/^### `(\w+)`/gm)) {
      const section = ref.split(/^## Entry /m).find((s) => s.includes(m[0]));
      if (section?.startsWith("`.`")) expect(index, m[1]).toContain(m[1]!);
    }
  });

  it("indexes every ADR", () => {
    const adrs = readdirSync(path.join(root, "docs/adr")).filter((f) => /^\d{4}-.*\.md$/.test(f));
    const readme = read("docs/adr/README.md");
    expect(adrs.length).toBeGreaterThanOrEqual(8);
    for (const a of adrs) expect(readme).toContain(`](${a})`);
  });
});
