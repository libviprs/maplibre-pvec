import http from "node:http";
import type { AddressInfo } from "node:net";

/** Hermetic range origin: stands in for object storage. Binds 127.0.0.1 only. */
export interface OriginMode {
  etag?: string | null; // null = no ETag header
  ignoreRange?: boolean; // answer 200 with the whole body
  multipart?: boolean;
  omitContentRange?: boolean;
  exposeHeaders?: string; // Access-Control-Expose-Headers value
  latencyMs?: number;
  /** Status codes to answer with for the next N range requests, in order. */
  failures?: number[];
  truncateBy?: number; // send this many fewer bytes, with a consistent length
  resetMidBody?: boolean;
  cacheControl?: string;
}
export interface LoggedRequest {
  method: string;
  url: string;
  range: string | undefined;
  ifMatch: string | undefined;
  status: number;
}

export class RangeOrigin {
  readonly log: LoggedRequest[] = [];
  mode: OriginMode = { etag: '"v1"', exposeHeaders: "ETag, Content-Range, Accept-Ranges" };
  private server: http.Server;
  constructor(public body: Uint8Array) {
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }
  async start(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  swap(body: Uint8Array, etag: string): void {
    this.body = body;
    this.mode.etag = etag;
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const m = this.mode;
    const log = (status: number): void => {
      this.log.push({
        method: req.method ?? "",
        url: req.url ?? "",
        range: req.headers.range,
        ifMatch: req.headers["if-match"] as string | undefined,
        status,
      });
    };
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Headers", "Range, If-Match");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD");
      res.setHeader("Access-Control-Max-Age", "600");
      res.writeHead(204).end();
      log(204);
      return;
    }
    if (m.exposeHeaders) res.setHeader("Access-Control-Expose-Headers", m.exposeHeaders);
    if (m.etag) res.setHeader("ETag", m.etag);
    if (m.cacheControl) res.setHeader("Cache-Control", m.cacheControl);
    res.setHeader("Accept-Ranges", "bytes");
    if (m.latencyMs) await new Promise((r) => setTimeout(r, m.latencyMs));
    const fail = m.failures?.shift();
    if (fail !== undefined) {
      res.writeHead(fail).end();
      log(fail);
      return;
    }
    if (req.headers["if-match"] && m.etag && req.headers["if-match"] !== m.etag) {
      res.writeHead(412).end();
      log(412);
      return;
    }
    const total = this.body.length;
    const range = req.headers.range;
    const match = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
    if (!match || m.ignoreRange) {
      res.writeHead(200, { "Content-Length": total });
      res.end(this.body);
      log(200);
      return;
    }
    const start = Number(match[1]);
    let end = Number(match[2]);
    if (start >= total) {
      res.writeHead(416, { "Content-Range": `bytes */${total}` }).end();
      log(416);
      return;
    }
    end = Math.min(end, total - 1);
    let slice = this.body.subarray(start, end + 1);
    if (m.multipart) {
      res.writeHead(206, { "Content-Type": "multipart/byteranges; boundary=XX" });
      res.end(Buffer.from(`--XX\r\n\r\n${Buffer.from(slice).toString("latin1")}\r\n--XX--`, "latin1"));
      log(206);
      return;
    }
    const headers: Record<string, string | number> = {};
    if (!m.omitContentRange) headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
    if (m.truncateBy) slice = slice.subarray(0, Math.max(0, slice.length - m.truncateBy));
    headers["Content-Length"] = slice.length;
    res.writeHead(206, headers);
    if (m.resetMidBody) {
      res.write(slice.subarray(0, Math.floor(slice.length / 2)));
      setTimeout(() => req.socket.destroy(), 5);
      log(206);
      return;
    }
    res.end(slice);
    log(206);
  }
}

/** A tiny caching reverse proxy standing in for a CDN. Caches only `immutable` responses. */
export class CachingProxy {
  readonly hits: string[] = [];
  readonly misses: string[] = [];
  private cache = new Map<string, { status: number; headers: Record<string, string>; body: Buffer }>();
  private server: http.Server;
  constructor(private upstream: string) {
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }
  async start(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const key = `${req.url}|${req.headers.range ?? ""}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.hits.push(key);
      res.writeHead(cached.status, { ...cached.headers, "X-Cache": "HIT" }).end(cached.body);
      return;
    }
    this.misses.push(key);
    const headers: Record<string, string> = {};
    if (req.headers.range) headers.Range = req.headers.range;
    if (req.headers["if-match"]) headers["If-Match"] = req.headers["if-match"] as string;
    const up = await fetch(this.upstream + (req.url ?? ""), { headers });
    const body = Buffer.from(await up.arrayBuffer());
    const out: Record<string, string> = {};
    up.headers.forEach((v, k) => {
      if (k !== "content-encoding" && k !== "transfer-encoding") out[k] = v;
    });
    if ((up.headers.get("cache-control") ?? "").includes("immutable") && up.status < 300) {
      this.cache.set(key, { status: up.status, headers: out, body });
    }
    res.writeHead(up.status, { ...out, "X-Cache": "MISS" }).end(body);
  }
}

/**
 * Emulates the browser CORS rule for response headers: only safelisted headers and those named
 * in Access-Control-Expose-Headers are visible to script. Node's fetch has no such filter, so
 * the tests apply it themselves to catch a bucket that does not expose ETag or Content-Range.
 */
export function corsFilteredFetch(inner: typeof fetch = fetch): typeof fetch {
  const safelisted = new Set(["cache-control", "content-language", "content-length", "content-type", "expires", "last-modified", "pragma"]);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await inner(input, init);
    const exposed = new Set(
      (res.headers.get("access-control-expose-headers") ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );
    const visible = new Headers();
    res.headers.forEach((v, k) => {
      if (safelisted.has(k) || exposed.has(k) || k.startsWith("access-control-")) visible.set(k, v);
    });
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: visible });
  }) as typeof fetch;
}

/** Counting fetch stub: records every call, including headers. */
export function countingFetch(inner: typeof fetch = fetch): {
  fetch: typeof fetch;
  calls: { url: string; headers: Record<string, string>; signal?: AbortSignal | undefined }[];
} {
  const calls: { url: string; headers: Record<string, string>; signal?: AbortSignal | undefined }[] = [];
  const f = ((input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url: String(input), headers, signal: init?.signal ?? undefined });
    return inner(input, init);
  }) as typeof fetch;
  return { fetch: f, calls };
}
