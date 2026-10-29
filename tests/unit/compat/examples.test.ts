import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return n === "out" || n === "node_modules" ? [] : statSync(p).isDirectory() ? walk(p) : [p];
  });
const files = walk(join(root, "examples")).filter((f) => /\.(html|js|mjs|css|md|sh|json)$/.test(f));
const serveUrl = join(root, "examples/lib/serve.mjs");
const portFree = (port: number): Promise<boolean> =>
  new Promise((r) => {
    const s = createServer();
    s.once("error", () => r(false));
    s.listen(port, "127.0.0.1", () => s.close(() => r(true)));
  });

describe("#31 M7.8 example hygiene", () => {
  it("no file under examples/ names an origin other than localhost or 127.0.0.1", () => {
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/https?:\/\/([^/\s"'`)<>]+)/g)) {
        expect(["localhost", "127.0.0.1"], `${f} references ${m[0]}`).toContain(m[1]!.replace(/:(\d+|\$\{port\})$/, ""));
      }
    }
  });

  it("no example reads an API key or token", () => {
    for (const f of files.filter((x) => !x.endsWith("README.md"))) expect(readFileSync(f, "utf8"), f).not.toMatch(/api[-_ ]?key|access[-_ ]?token|apikey|[?&]key=/i);
  });

  it("the server is gone and its port free after a run, including when the run throws", async () => {
    const { withServer } = (await import(/* @vite-ignore */ serveUrl)) as { withServer: (o: object, f: (s: { port: number }) => Promise<void>) => Promise<void> };
    let port = 0;
    await withServer({}, async (s) => {
      port = s.port;
      expect(await portFree(port)).toBe(false);
    });
    expect(await portFree(port)).toBe(true);
    await expect(
      withServer({}, async (s) => {
        port = s.port;
        throw new Error("example failed");
      }),
    ).rejects.toThrow("example failed");
    expect(await portFree(port)).toBe(true);
  });

  it("serves Range requests from the in-memory fixtures", async () => {
    const { withServer } = (await import(/* @vite-ignore */ serveUrl)) as { withServer: (o: object, f: (s: { url: string }) => Promise<void>) => Promise<void> };
    await withServer({ fixtures: { "/f.bin": new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]) } }, async (s) => {
      const r = await fetch(`${s.url}/f.bin`, { headers: { range: "bytes=2-4" } });
      expect(r.status).toBe(206);
      expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([2, 3, 4]);
      expect(r.headers.get("content-range")).toBe("bytes 2-4/8");
    });
  });
});
