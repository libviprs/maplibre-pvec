// Packs the build, checks the tarball contents, installs it into a clean directory and uses it from
// there, then runs publint and arethetypeswrong. Runs in a throw-away container. Never publishes.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const fail = (m) => (console.error("pack-check: " + m), process.exit(1));

const work = mkdtempSync(join(tmpdir(), "pack-"));
const out = run("npm", ["pack", "--json", "--pack-destination", work], root);
const tarball = join(work, JSON.parse(out)[0].filename);
const files = run("tar", ["-tzf", tarball], work).split("\n").filter(Boolean);
for (const need of ["package/dist/pvec_eval.wasm", "package/dist/index.js", "package/dist/index.d.ts", "package/dist/style.d.ts", "package/dist/text.d.ts", "package/dist/hatch.d.ts", "package/dist/wasm.d.ts", "package/dist/wasm.js", "package/LICENSE", "package/package.json"]) {
  if (!files.includes(need)) fail(`tarball lacks ${need}`);
}
const stray = files.filter((f) => !/^package\/(dist\/|LICENSE|README\.md|package\.json)/.test(f));
if (stray.length) fail(`tarball carries files outside dist: ${stray.join(", ")}`);
const manifest = JSON.parse(run("tar", ["-xzOf", tarball, "package/package.json"], work));
if (manifest.dependencies && Object.keys(manifest.dependencies).length) fail("runtime dependencies are declared");

// Clean directory, nothing from the development tree reachable.
const clean = mkdtempSync(join(tmpdir(), "consumer-"));
writeFileSync(join(clean, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
run("npm", ["install", "--no-audit", "--no-fund", tarball], clean);
writeFileSync(
  join(clean, "use.mjs"),
  `
import { readFile } from "node:fs/promises";
import * as root from "maplibre-pvec";
import * as wasm from "maplibre-pvec/wasm";
import * as style from "maplibre-pvec/style";
import * as text from "maplibre-pvec/text";
import * as hatch from "maplibre-pvec/hatch";
let fetched = 0;
const ev = await wasm.loadEvaluator({}, { fetch: async (u) => { fetched++; return new Response(await readFile(new URL(u)), { headers: { "content-type": "application/wasm" } }); } });
console.log(JSON.stringify({ root: Object.keys(root).sort(), abi: ev.abiVersion, source: ev.source, fetched, entries: { style: Object.keys(style), text: Object.keys(text), hatch: Object.keys(hatch) } }));
`,
);
const used = JSON.parse(run("node", ["use.mjs"], clean).trim());
if (used.abi !== 1 || used.fetched !== 1 || false) fail("clean install did not behave: " + JSON.stringify(used));
if (!used.root.includes("createPVecLayer")) fail("root entry lacks createPVecLayer");

// Importing for type-only use must not fetch: import only, no loadEvaluator call.
writeFileSync(join(clean, "noop.mjs"), `globalThis.fetch = () => { throw new Error("fetched"); }; await import("maplibre-pvec"); await import("maplibre-pvec/wasm"); console.log("no fetch");`);
if (run("node", ["noop.mjs"], clean).trim() !== "no fetch") fail("an import fetched");

// publint on the unpacked tree, attw on the tarball.
const unpack = join(work, "unpacked");
mkdirSync(unpack);
run("tar", ["-xzf", tarball, "-C", unpack], work);
const bin = (n) => join(root, "node_modules/.bin", n);
const pl = run(bin("publint"), [join(unpack, "package"), "--strict"], root);
console.log(pl.trim());
const attw = run(bin("attw"), [tarball, "--no-emoji", "--ignore-rules", "cjs-resolves-to-esm", "--exclude-entrypoints", "./wasm/pvec_eval.wasm", "./package.json"], root);
console.log(attw.trim());
console.log(JSON.stringify({ tarball: tarball.split("/").pop(), files: files.length, bytes: readFileSync(tarball).length, dependencies: 0, ok: true }));
