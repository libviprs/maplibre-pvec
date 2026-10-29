/** In-memory range fetch: no sockets, deterministic, with start/end hooks for concurrency tests. */
export interface MemoryFetchOptions {
  etag?: string | null;
  delayMs?: () => number;
  onStart?: (range: [number, number]) => void;
  onEnd?: (range: [number, number]) => void;
  contentRange?: (start: number, end: number, total: number) => string;
}
export function memoryFetch(body: Uint8Array, o: MemoryFetchOptions = {}): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    const m = /^bytes=(\d+)-(\d+)$/.exec(h.get("range") ?? "");
    if (!m) return new Response(body, { status: 200 });
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), body.length - 1);
    const r: [number, number] = [start, end];
    o.onStart?.(r);
    const d = o.delayMs?.() ?? 0;
    if (d > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, d);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    init?.signal?.throwIfAborted();
    o.onEnd?.(r);
    const headers = new Headers({
      "Content-Range": o.contentRange ? o.contentRange(start, end, body.length) : `bytes ${start}-${end}/${body.length}`,
    });
    if (o.etag !== null) headers.set("ETag", o.etag ?? '"mem"');
    return new Response(body.slice(start, end + 1), { status: 206, headers });
  }) as typeof fetch;
}
