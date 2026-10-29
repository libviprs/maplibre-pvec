import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PVecSource } from "../../src/source/PVecSource";
import { PVecTransportError } from "../../src/source/errors";
import { buildPvec, gridSpec } from "./helpers/fixture";
import { CachingProxy, RangeOrigin, corsFilteredFetch, countingFetch } from "./helpers/origin";

let origin: RangeOrigin;
let base: string;
const bytes = buildPvec(gridSpec()).bytes;
beforeEach(async () => {
  origin = new RangeOrigin(bytes);
  base = await origin.start();
});
afterEach(async () => origin.stop());

const noSleep = (delays: number[]) => ({ sleep: async (ms: number) => void delays.push(ms), random: () => 0.5 });
const code = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(PVecTransportError);
  return (e as PVecTransportError).code;
};

describe("#18 M3.8 object-storage transport (hermetic origin on 127.0.0.1)", () => {
  it("answers the CORS preflight with every header the source sends", async () => {
    const c = countingFetch();
    const s = new PVecSource({ url: `${base}/p.pvec`, fetch: c.fetch, headers: { Authorization: "x" } });
    await s.bootstrap();
    await s.readRange(4096, 16);
    const pre = await fetch(`${base}/p.pvec`, { method: "OPTIONS" });
    const allowed = (pre.headers.get("access-control-allow-headers") ?? "").toLowerCase().split(",").map((x) => x.trim());
    const safelisted = new Set(["accept", "accept-language", "content-language", "content-type"]);
    const sent = new Set(c.calls.flatMap((r) => Object.keys(r.headers)));
    // Authorization is the caller's own header, so it is the caller's CORS config to allow.
    sent.delete("authorization");
    for (const h of sent) expect(allowed.includes(h) || safelisted.has(h)).toBe(true);
  });

  it("reads 206 with a correct Content-Range", async () => {
    const s = new PVecSource({ url: `${base}/p.pvec` });
    const out = await s.readRange(100, 50);
    expect(out).toEqual(bytes.subarray(100, 150));
    expect(s.artifactLength).toBe(bytes.length);
  });

  it("refuses a 200 answer to a range request", async () => {
    origin.mode.ignoreRange = true;
    expect(await code(new PVecSource({ url: `${base}/p.pvec` }).readRange(100, 50))).toBe("range-ignored");
    expect(origin.log).toHaveLength(1); // not retried
  });

  it("refuses a multipart/byteranges answer to a single-range request", async () => {
    origin.mode.multipart = true;
    expect(await code(new PVecSource({ url: `${base}/p.pvec` }).readRange(100, 50))).toBe("multipart-unsupported");
  });

  it("types a 416 and does not retry it", async () => {
    const s = new PVecSource({ url: `${base}/p.pvec` });
    expect(await code(s.readRange(bytes.length + 10, 5))).toBe("range-unsatisfiable");
    expect(origin.log).toHaveLength(1);
  });

  it("retries 500 and 503 with jittered backoff, bounded, and reports the attempt count", async () => {
    origin.mode.failures = [500, 503];
    const delays: number[] = [];
    const s = new PVecSource({ url: `${base}/p.pvec` }, noSleep(delays));
    await s.readRange(0, 16);
    expect(origin.log.map((r) => r.status)).toEqual([500, 503, 206]);
    expect(s.stats.retries).toBe(2);
    expect(delays).toHaveLength(2);
    // full jitter at random=0.5: half of base * 2^attempt, base 100 ms
    expect(delays).toEqual([50, 100]);
  });

  it("gives up after the stated maximum of attempts with a typed error", async () => {
    origin.mode.failures = [503, 503, 503, 503, 503, 503];
    const delays: number[] = [];
    const s = new PVecSource({ url: `${base}/p.pvec`, limits: { maxRetries: 3 } }, noSleep(delays));
    expect(await code(s.readRange(0, 16))).toBe("server-error");
    expect(origin.log).toHaveLength(4); // 1 + maxRetries
    expect(delays.length).toBe(3);
    expect(Math.max(...delays)).toBeLessThanOrEqual(5000);
  });

  it("types a truncated body after bounded retries", async () => {
    origin.mode.truncateBy = 10;
    const s = new PVecSource({ url: `${base}/p.pvec`, limits: { maxRetries: 2 } }, noSleep([]));
    expect(await code(s.readRange(0, 100))).toBe("truncated");
    expect(origin.log).toHaveLength(3);
  });

  it("types a connection reset mid-range after bounded retries", async () => {
    origin.mode.resetMidBody = true;
    const s = new PVecSource({ url: `${base}/p.pvec`, limits: { maxRetries: 2 } }, noSleep([]));
    expect(await code(s.readRange(0, 8000))).toBe("connection-reset");
    expect(origin.log).toHaveLength(3);
  });

  it("names a missing Content-Range exposure as a deployment error and renders nothing", async () => {
    origin.mode.exposeHeaders = "ETag, Accept-Ranges";
    const s = new PVecSource({ url: `${base}/p.pvec`, fetch: corsFilteredFetch() });
    const err = await s.bootstrap().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PVecTransportError);
    expect((err as PVecTransportError).code).toBe("missing-expose-header");
    expect((err as PVecTransportError).detail.header).toBe("Content-Range");
    expect(s.handle).toBeUndefined();
    expect(() => s.queryBounds({ minX: 0, minY: 0, maxX: 1, maxY: 1 })).toThrow();
    expect(origin.log).toHaveLength(1);
  });

  it("names a missing ETag exposure as a deployment error", async () => {
    origin.mode.exposeHeaders = "Content-Range, Accept-Ranges";
    const s = new PVecSource({ url: `${base}/p.pvec`, fetch: corsFilteredFetch() });
    const err = await s.bootstrap().catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/ETag/);
    expect((err as Error).message).toMatch(/Access-Control-Expose-Headers/);
    expect(s.handle).toBeUndefined();
  });

  it("works through a caching proxy: immutable responses are served from the proxy on the second read", async () => {
    origin.mode.cacheControl = "public, max-age=31536000, immutable";
    const proxy = new CachingProxy(base);
    const pbase = await proxy.start();
    try {
      const s = new PVecSource({ url: `${pbase}/p.pvec` });
      const a = await s.readRange(2000, 256);
      const b = await new PVecSource({ url: `${pbase}/p.pvec` }).readRange(2000, 256);
      expect(b).toEqual(a);
      expect(proxy.misses).toHaveLength(1);
      expect(proxy.hits).toHaveLength(1);
      expect(origin.log).toHaveLength(1);
    } finally {
      await proxy.stop();
    }
  });

  it("a non-immutable response is not cached by the proxy", async () => {
    const proxy = new CachingProxy(base);
    const pbase = await proxy.start();
    try {
      await new PVecSource({ url: `${pbase}/p.pvec` }).readRange(2000, 64);
      await new PVecSource({ url: `${pbase}/p.pvec` }).readRange(2000, 64);
      expect(proxy.hits).toHaveLength(0);
      expect(origin.log).toHaveLength(2);
    } finally {
      await proxy.stop();
    }
  });

  it("an abort is a normal outcome, typed as an abort and never retried", async () => {
    origin.mode.latencyMs = 100;
    const ac = new AbortController();
    const s = new PVecSource({ url: `${base}/p.pvec` });
    const p = s.readRange(0, 16, { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    const e = await p.catch((x: unknown) => x);
    expect((e as { code: string }).code).toBe("aborted");
    expect(s.stats.retries).toBe(0);
  });
});
