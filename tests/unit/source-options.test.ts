import { describe, expect, it, vi, afterEach } from "vitest";
import { PVecSource } from "../../src/source/PVecSource";
import { PVecOptionError } from "../../src/source/errors";
import { readFileSync } from "node:fs";
import { buildPvec, gridSpec } from "./helpers/fixture";
import { memoryFetch } from "./helpers/memory";

const URL_OK = "https://example.test/plan.pvec";
afterEach(() => vi.unstubAllGlobals());

describe("#18 M3.1 PVecSource options", () => {
  it("constructing with only url yields the documented defaults", () => {
    const s = new PVecSource({ url: URL_OK }, { hardwareConcurrency: 8 });
    expect(s.options.url).toBe(URL_OK);
    expect(s.options.headers).toEqual({});
    expect(s.options.cacheBudgetBytes).toEqual({
      compressed: 64 * 1024 * 1024,
      decoded: 128 * 1024 * 1024,
      gpu: 128 * 1024 * 1024,
    });
    expect(s.options.limits).toEqual({
      maxDecompressedBytes: 268435456,
      maxEntities: 16777216,
      maxConcurrentRequests: 6,
      maxQueuedBytes: 67108864,
      maxQueuedJobs: 256,
      maxRetries: 3,
    });
  });

  it.each([
    [8, 4],
    [4, 3],
    [2, 1],
    [1, 1],
    [undefined, 2],
  ])("workerCount defaults from hardwareConcurrency %s to %s", (hc, expected) => {
    expect(new PVecSource({ url: URL_OK }, { hardwareConcurrency: hc }).options.workerCount).toBe(expected);
  });

  it("merges partial cache budgets and limits over the defaults", () => {
    const s = new PVecSource({ url: URL_OK, cacheBudgetBytes: { gpu: 1024 }, limits: { maxEntities: 5 }, workerCount: 3 });
    expect(s.options.cacheBudgetBytes.gpu).toBe(1024);
    expect(s.options.cacheBudgetBytes.compressed).toBe(64 * 1024 * 1024);
    expect(s.options.limits.maxEntities).toBe(5);
    expect(s.options.limits.maxConcurrentRequests).toBe(6);
    expect(s.options.workerCount).toBe(3);
  });

  it.each([
    ["zero cache budget", { url: URL_OK, cacheBudgetBytes: { decoded: 0 } }, "cache-budget-invalid"],
    ["negative cache budget", { url: URL_OK, cacheBudgetBytes: { compressed: -1 } }, "cache-budget-invalid"],
    ["worker count below 1", { url: URL_OK, workerCount: 0 }, "worker-count-invalid"],
    ["fractional worker count", { url: URL_OK, workerCount: 1.5 }, "worker-count-invalid"],
    ["relative url", { url: "/plan.pvec" }, "url-not-absolute"],
    ["empty url", { url: "" }, "url-not-absolute"],
    ["zero limit", { url: URL_OK, limits: { maxConcurrentRequests: 0 } }, "limit-invalid"],
    ["zero queued bytes", { url: URL_OK, limits: { maxQueuedBytes: 0 } }, "limit-invalid"],
  ])("rejects %s at construction with a distinct typed error", (_n, opts, code) => {
    let err: unknown;
    try {
      new PVecSource(opts);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PVecOptionError);
    expect((err as PVecOptionError).code).toBe(code);
  });

  it("sends every request through the supplied fetch and none through global fetch", async () => {
    const global = vi.fn(() => {
      throw new Error("global fetch used");
    });
    vi.stubGlobal("fetch", global);
    const body = buildPvec(gridSpec()).bytes;
    const calls: Headers[] = [];
    const inner = memoryFetch(body);
    const stub = ((i: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Headers(init?.headers));
      return inner(i, init);
    }) as typeof fetch;
    const s = new PVecSource({ url: URL_OK, fetch: stub, headers: { Authorization: "Bearer t" } });
    await s.readRange(0, 64);
    await s.readRange(64, 64);
    expect(global).not.toHaveBeenCalled();
    expect(calls.map((h) => h.get("range"))).toEqual(["bytes=0-63", "bytes=64-127"]);
    expect(calls.every((h) => h.get("authorization") === "Bearer t")).toBe(true);
  });

  it("has no tile, zoom or tile size anywhere in the option surface", () => {
    const s = new PVecSource({ url: URL_OK });
    const keys: string[] = [];
    const walk = (o: object, p = ""): void => {
      for (const [k, v] of Object.entries(o)) {
        keys.push(p + k);
        if (v && typeof v === "object") walk(v, `${p}${k}.`);
      }
    };
    walk(s.options);
    expect(keys.filter((k) => /tile|zoom|(^|\.)[xyz]$/i.test(k))).toEqual([]);
  });

  it("queryBounds returns the same chunk set whatever the map zoom, and takes no zoom", async () => {
    const body = buildPvec(gridSpec()).bytes;
    const s = new PVecSource({ url: URL_OK, fetch: memoryFetch(body) });
    await s.bootstrap();
    const b = { minX: 100, minY: 100, maxX: 600, maxY: 400 };
    const atZoom3 = s.queryBounds(b).map((c) => c.cell);
    // @ts-expect-error queryBounds accepts source-space bounds only
    const atZoom18 = s.queryBounds(b, 18).map((c) => c.cell);
    expect(atZoom3).toEqual(atZoom18);
    expect(atZoom3).toEqual([0, 1, 2, 4, 5, 6]);
  });

  it("queryBounds before bootstrap is a typed refusal", () => {
    expect(() => new PVecSource({ url: URL_OK }).queryBounds({ minX: 0, minY: 0, maxX: 1, maxY: 1 })).toThrow(/bootstrap/);
  });

  it("the options type declares no any", () => {
    const text = readFileSync(new URL("../../src/source/PVecSource.ts", import.meta.url), "utf8");
    expect(text).not.toMatch(/:\s*any\b|<any>|\bas any\b/);
  });
});
