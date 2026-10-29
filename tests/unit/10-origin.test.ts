import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOrigin } from "../../tools/fixture-origin.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "corpus");
let server: Server;
let base = "";
const path = "/corpus/r0-open/manifest.json";

beforeAll(async () => {
  server = createOrigin({ corpusDir: root });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("#10 hermetic fixture origin", () => {
  it("serves a whole file with CORS and Accept-Ranges", async () => {
    const r = await fetch(base + path);
    expect(r.status).toBe(200);
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("access-control-expose-headers")).toContain("Content-Range");
  });

  it("serves a byte range as 206 with Content-Range", async () => {
    const whole = new Uint8Array(await (await fetch(base + path)).arrayBuffer());
    const r = await fetch(base + path, { headers: { Range: "bytes=2-9" } });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe(`bytes 2-9/${whole.length}`);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(whole.slice(2, 10));
  });

  it("serves a suffix range", async () => {
    const whole = new Uint8Array(await (await fetch(base + path)).arrayBuffer());
    const r = await fetch(base + path, { headers: { Range: "bytes=-5" } });
    expect(r.status).toBe(206);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(whole.slice(-5));
  });

  it("refuses an unsatisfiable range with 416 and the file length", async () => {
    const r = await fetch(base + path, { headers: { Range: "bytes=99999999-" } });
    expect(r.status).toBe(416);
    expect(r.headers.get("content-range")).toMatch(/^bytes \*\/\d+$/);
  });

  it("answers a CORS preflight that allows the Range header", async () => {
    const r = await fetch(base + path, { method: "OPTIONS", headers: { "Access-Control-Request-Headers": "range" } });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("range");
  });

  it("serves a deliberately corrupted copy under /corrupt/ and refuses path escapes", async () => {
    const good = new Uint8Array(await (await fetch(base + path)).arrayBuffer());
    const bad = new Uint8Array(await (await fetch(base + "/corrupt" + path)).arrayBuffer());
    expect(bad.length).toBe(good.length);
    expect(bad).not.toEqual(good);
    expect((await fetch(base + "/corpus/../../package.json")).status).toBe(404);
    expect((await fetch(base + "/corpus/%2e%2e/%2e%2e/package.json")).status).toBe(404);
  });
});
