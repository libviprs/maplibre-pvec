import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createPVecLayer } from "../../../src/index";
import { controlOf } from "../../../src/layer/internal";
import { monochromeStyleResolver, registerStyle } from "../../../src/style/index";
import { countingGl, fakeMap, rig, type Rig } from "./helpers";

let r: Rig;
beforeEach(async () => (r = await rig()));
afterEach(async () => r.stop());

describe("#26 M7.4 component hooks", () => {
  it("runs with zero components and uses the monochrome stroke default", () => {
    const layer = createPVecLayer({ id: "a", source: { url: r.url } });
    expect(layer.wantedCapabilities()).toEqual([]);
    expect(layer.resolveStyle({ entityId: "e" })).toEqual(monochromeStyleResolver({ entityId: "e" }));
  });

  it("a registered hook makes only its capability wanted, and unregistering removes it", () => {
    const layer = createPVecLayer({ id: "a", source: { url: r.url } });
    const off = layer.registerComponent("text", { render: () => undefined });
    expect(layer.wantedCapabilities()).toEqual(["text"]);
    layer.registerComponent("hatch", { render: () => undefined });
    expect(layer.wantedCapabilities()).toEqual(["hatch", "text"]);
    off();
    expect(layer.wantedCapabilities()).toEqual(["hatch"]);
  });

  it("registering after onAdd tells the engine which kind changed", async () => {
    const layer = createPVecLayer({ id: "a", source: { url: r.url } });
    const changed: string[] = [];
    controlOf(layer).setHooks({ onComponentChange: (k) => void changed.push(k) });
    const { gl } = countingGl();
    layer.onAdd(fakeMap, gl);
    await layer.whenReady();
    registerStyle(layer);
    expect(changed).toEqual(["style"]);
    layer.onRemove(fakeMap, gl);
  });

  it("a throwing StyleResolver leaves the default style, emits exactly one error and does not stop other entities", () => {
    const layer = createPVecLayer({ id: "a", source: { url: r.url } });
    const errors: { code: string; context: Record<string, unknown> }[] = [];
    layer.on("error", (e) => errors.push(e));
    layer.registerComponent("style", {
      resolve: (e) => {
        if (e.entityId === "bad") throw new Error("nope");
        return { widthPx: 3, dash: [], color: "#123456" };
      },
    });
    const dflt = monochromeStyleResolver({ entityId: "bad" });
    expect(layer.resolveStyle({ entityId: "bad" })).toEqual(dflt);
    expect(layer.resolveStyle({ entityId: "bad" })).toEqual(dflt);
    expect(layer.resolveStyle({ entityId: "ok" })).toEqual({ widthPx: 3, dash: [], color: "#123456" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "component_failed", context: { entityId: "bad", kind: "style" } });
  });

  it("a LayerFilter that throws keeps the entity visible", () => {
    const layer = createPVecLayer({ id: "a", source: { url: r.url } });
    layer.registerComponent("layerFilter", {
      visible: () => {
        throw new Error("x");
      },
    });
    expect(layer.isEntityVisible({ entityId: "e" })).toBe(true);
  });

  it("the entry point pulls in no text or hatch module, and the subpaths are separate files", () => {
    const root = path.resolve(__dirname, "../../..");
    const dirs = readdirSync(path.join(root, "src"));
    expect(dirs).toEqual(expect.arrayContaining(["style", "text", "hatch"]));
    const seen = new Set<string>();
    const walk = (f: string): void => {
      const full = path.resolve(f);
      if (seen.has(full)) return;
      seen.add(full);
      const src = readFileSync(full, "utf8");
      for (const m of src.matchAll(/from ["'](\.[^"']+)["']/g)) {
        const base = path.resolve(path.dirname(full), m[1]!);
        for (const cand of [`${base}.ts`, path.join(base, "index.ts")]) {
          try {
            readFileSync(cand);
            walk(cand);
            break;
          } catch {
            /* next candidate */
          }
        }
      }
    };
    walk(path.join(root, "src/index.ts"));
    const rel = [...seen].map((p) => path.relative(root, p));
    expect(rel.filter((p) => /src\/(text|hatch|style)\//.test(p))).toEqual([]);
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { exports: Record<string, unknown> };
    expect(Object.keys(pkg.exports).sort()).toEqual([".", "./hatch", "./package.json", "./style", "./text", "./wasm", "./wasm/pvec_eval.wasm"]);
  });
});
