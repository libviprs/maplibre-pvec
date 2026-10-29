import { TieredCache, type Tier } from "./cache";
import { RttBandwidthEstimator } from "./coalesce";
import { bootstrap, type PVecHandle } from "./bootstrap";
import {
  PVecAbortError,
  PVecError,
  PVecOptionError,
  PVecTransportError,
  PVecVersionError,
  type PVecOptionErrorCode,
} from "./errors";
import type { VersionIdentity } from "./version";

/** Source-space bounds in the artifact's declared length unit. Never display or tile coordinates. */
export interface PVecBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A spatial chunk of the file. Chunks are not display zoom tiles. */
export interface PVecChunk {
  index: number;
  cell: number;
  offset: number;
  length: number;
  bounds: PVecBounds;
  kind: number;
}

/** Per-tier cache ceilings in bytes. */
export interface CacheBudgetBytes {
  compressed: number;
  decoded: number;
  gpu: number;
}

export interface PVecLimits {
  /** Largest total of decoded bytes the browser may hold. Matches the browser preset of LIMIT-03. */
  maxDecompressedBytes: number;
  /** LIMIT-07 browser preset. */
  maxEntities: number;
  maxConcurrentRequests: number;
  /** Bytes queued or in flight in the range scheduler. */
  maxQueuedBytes: number;
  maxQueuedJobs: number;
  /** Retries after the first attempt for 5xx, truncated bodies and resets. Zero turns retrying off. */
  maxRetries: number;
}

export interface PVecSourceOptions {
  /** Absolute URL of the .pvec artifact. */
  url: string;
  /** Fetch implementation for auth, signing or instrumentation. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Static headers merged into every range request. */
  headers?: Record<string, string>;
  cacheBudgetBytes?: Partial<CacheBudgetBytes>;
  /** Worker pool size. Defaults from hardwareConcurrency: one less than the cores, between 1 and 4. */
  workerCount?: number;
  limits?: Partial<PVecLimits>;
}

export interface ResolvedPVecOptions {
  url: string;
  headers: Record<string, string>;
  cacheBudgetBytes: CacheBudgetBytes;
  workerCount: number;
  limits: PVecLimits;
}

/** The one place defaults are declared. Memory numbers follow the browser preset of SECURITY_LIMITS.md. */
const DEFAULT_CACHE_BUDGET: CacheBudgetBytes = {
  compressed: 64 * 1024 * 1024, // PROVISIONAL (M8.6)
  decoded: 128 * 1024 * 1024, // PROVISIONAL (M8.6)
  gpu: 128 * 1024 * 1024, // PROVISIONAL (M8.6)
};
const DEFAULT_LIMITS: PVecLimits = {
  maxDecompressedBytes: 256 * 1024 * 1024,
  maxEntities: 1 << 24,
  maxConcurrentRequests: 6, // PROVISIONAL (M8.6): the HTTP/1.1 per-origin connection count
  maxQueuedBytes: 64 * 1024 * 1024, // PROVISIONAL (M8.6)
  maxQueuedJobs: 256, // PROVISIONAL (M8.6)
  maxRetries: 3,
};
const COLD_WORKERS = 2;
const MAX_DEFAULT_WORKERS = 4;
const BACKOFF_BASE_MS = 100;
const BACKOFF_CAP_MS = 5000;

/** Test seams. Nothing here is public API. */
export interface SourceInternals {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  hardwareConcurrency?: number | undefined;
}

export interface InvalidationEvent {
  previous: VersionIdentity | undefined;
  current: VersionIdentity;
}

function bad(code: PVecOptionErrorCode, message: string): never {
  throw new PVecOptionError(code, message);
}
const positiveInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;

function resolveOptions(o: PVecSourceOptions, hc: number | undefined): ResolvedPVecOptions {
  if (typeof o.url !== "string" || !/^[a-z][a-z0-9+.-]*:\/\//i.test(o.url)) {
    bad("url-not-absolute", `url must be absolute, got ${JSON.stringify(o.url)}`);
  }
  try {
    new URL(o.url);
  } catch {
    bad("url-not-absolute", `url is not parseable: ${o.url}`);
  }
  const cacheBudgetBytes = { ...DEFAULT_CACHE_BUDGET };
  for (const [tier, v] of Object.entries(o.cacheBudgetBytes ?? {})) {
    if (v === undefined) continue;
    if (!positiveInt(v)) bad("cache-budget-invalid", `cacheBudgetBytes.${tier} must be a positive integer, got ${String(v)}`);
    cacheBudgetBytes[tier as Tier] = v;
  }
  let workerCount: number;
  if (o.workerCount === undefined) {
    workerCount = hc === undefined ? COLD_WORKERS : Math.min(MAX_DEFAULT_WORKERS, Math.max(1, hc - 1));
  } else if (positiveInt(o.workerCount)) {
    workerCount = o.workerCount;
  } else {
    bad("worker-count-invalid", `workerCount must be an integer of at least 1, got ${String(o.workerCount)}`);
  }
  const limits = { ...DEFAULT_LIMITS };
  for (const [name, v] of Object.entries(o.limits ?? {})) {
    if (v === undefined) continue;
    const ok = name === "maxRetries" ? Number.isInteger(v) && (v as number) >= 0 : positiveInt(v);
    if (!ok) bad("limit-invalid", `limits.${name} must be a positive integer (maxRetries may be 0), got ${String(v)}`);
    (limits as unknown as Record<string, number>)[name] = v as number;
  }
  return { url: o.url, headers: { ...o.headers }, cacheBudgetBytes, workerCount, limits };
}

export class PVecSource {
  readonly options: ResolvedPVecOptions;
  readonly cache: TieredCache;
  readonly estimator = new RttBandwidthEstimator();
  readonly stats = { requests: 0, bytes: 0, retries: 0 };
  /** Set from the Content-Range of the first answer. */
  artifactLength: number | undefined;
  handle: PVecHandle | undefined;
  /** The ETag of the most recent answer, for bootstrap to pin. */
  lastEtag: string | null = null;

  private fetchImpl: typeof fetch;
  private internals: Required<Omit<SourceInternals, "hardwareConcurrency">>;
  private pin: VersionIdentity | undefined;
  private epoch = 0;
  private bootstrapPromise: Promise<PVecHandle> | undefined;
  private invalidating: Promise<void> | undefined;
  private listeners = new Set<(e: InvalidationEvent) => void>();
  private beforeListeners = new Set<() => void>();

  constructor(options: PVecSourceOptions, internals: SourceInternals = {}) {
    const hc = "hardwareConcurrency" in internals ? internals.hardwareConcurrency : globalThis.navigator?.hardwareConcurrency;
    this.options = resolveOptions(options, hc);
    this.fetchImpl = options.fetch ?? ((i, init) => globalThis.fetch(i, init));
    this.internals = {
      sleep: internals.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      random: internals.random ?? Math.random,
      now: internals.now ?? (() => performance.now()),
    };
    this.cache = new TieredCache(this.options.cacheBudgetBytes);
  }

  /** Header, manifest and directory only. Idempotent: later calls return the same handle. */
  bootstrap(): Promise<PVecHandle> {
    this.bootstrapPromise ??= bootstrap(this).then(
      (h) => (this.handle = h),
      (e: unknown) => {
        this.bootstrapPromise = undefined;
        throw e;
      },
    );
    return this.bootstrapPromise;
  }

  /** Chunks whose source-space bounds meet `bounds`. Takes no zoom: PVec chunks are not tiles. */
  queryBounds(bounds: PVecBounds): PVecChunk[] {
    if (!this.handle) throw new PVecError("not-bootstrapped", "call bootstrap() before queryBounds()");
    return this.handle.directory.query(bounds);
  }

  pinVersion(v: VersionIdentity): void {
    this.pin = v;
  }
  get version(): VersionIdentity | undefined {
    return this.pin;
  }

  onInvalidate(fn: (e: InvalidationEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  /** Runs synchronously when a version change is detected, before the caches are dropped. */
  onBeforeInvalidate(fn: () => void): () => void {
    this.beforeListeners.add(fn);
    return () => this.beforeListeners.delete(fn);
  }

  /** One range request with the pinned identity, validated, retried within the bound. */
  async readRange(offset: number, length: number, opts: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    const { maxRetries } = this.options.limits;
    const epoch = this.epoch;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt(offset, length, opts.signal, epoch);
      } catch (e) {
        const retryable = e instanceof PVecTransportError && RETRYABLE.has(e.code);
        if (!retryable || attempt >= maxRetries) throw e;
        this.stats.retries++;
        const window = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
        await this.internals.sleep(Math.floor(this.internals.random() * window));
        if (opts.signal?.aborted) throw new PVecAbortError();
      }
    }
  }

  private async attempt(offset: number, length: number, signal: AbortSignal | undefined, epoch: number): Promise<Uint8Array> {
    if (epoch !== this.epoch) throw versionChanged();
    const headers: Record<string, string> = { ...this.options.headers, Range: `bytes=${offset}-${offset + length - 1}` };
    if (this.pin?.kind === "etag") headers["If-Match"] = this.pin.value;
    this.stats.requests++;
    const t0 = this.internals.now();
    let res: Response;
    try {
      res = await this.fetchImpl(this.options.url, { headers, ...(signal ? { signal } : {}) });
    } catch (e) {
      if (signal?.aborted || isAbort(e)) throw new PVecAbortError();
      throw new PVecTransportError("connection-reset", `request failed: ${String(e)}`);
    }
    const ttfb = this.internals.now() - t0;
    if (res.status === 412) {
      void res.body?.cancel();
      await this.versionChanged(epoch);
    }
    if (res.status === 416) throw new PVecTransportError("range-unsatisfiable", `range ${offset}+${length} is outside the artifact`);
    if (res.status === 200) {
      void res.body?.cancel();
      throw new PVecTransportError("range-ignored", "the origin answered 200 to a range request. Serve byte ranges (Accept-Ranges: bytes) or fix the proxy that strips Range");
    }
    if (res.status >= 500) throw new PVecTransportError("server-error", `origin answered ${res.status}`, { status: res.status });
    if (res.status !== 206) throw new PVecTransportError("http-error", `unexpected status ${res.status}`, { status: res.status });
    if ((res.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/byteranges")) {
      void res.body?.cancel();
      throw new PVecTransportError("multipart-unsupported", "the origin answered a single-range request with multipart/byteranges");
    }
    const cr = res.headers.get("content-range");
    if (cr === null) {
      void res.body?.cancel();
      throw new PVecTransportError(
        "missing-expose-header",
        "206 response without a readable Content-Range. List Content-Range in Access-Control-Expose-Headers on the bucket or CDN",
        { header: "Content-Range" },
      );
    }
    const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(cr);
    if (!m) throw new PVecTransportError("content-range-mismatch", `unparseable Content-Range ${cr}`);
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (m[3] !== "*") this.artifactLength = Number(m[3]);
    const wantEnd = this.artifactLength === undefined ? offset + length - 1 : Math.min(offset + length - 1, this.artifactLength - 1);
    if (start !== offset || end !== wantEnd) {
      void res.body?.cancel();
      throw new PVecTransportError("content-range-mismatch", `asked for bytes ${offset}-${offset + length - 1}, got ${cr}`);
    }
    const etag = res.headers.get("etag");
    this.lastEtag = etag;
    if (this.pin?.kind === "etag" && etag !== null && etag !== this.pin.value) {
      void res.body?.cancel();
      await this.versionChanged(epoch);
    }
    let body: Uint8Array;
    try {
      body = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (signal?.aborted || isAbort(e)) throw new PVecAbortError();
      throw new PVecTransportError("connection-reset", `connection dropped mid-body: ${String(e)}`);
    }
    if (body.length !== end - start + 1) {
      throw new PVecTransportError("truncated", `expected ${end - start + 1} bytes, got ${body.length}`);
    }
    this.stats.bytes += body.length;
    this.estimator.record({ ttfbMs: ttfb, bodyMs: this.internals.now() - t0 - ttfb, bytes: body.length });
    return body;
  }

  /**
   * Atomic invalidation: abort in-flight work, drop all three cache tiers, forget the pin and the
   * handle, re-bootstrap, then emit exactly one event. Callers that raced the same change share it.
   */
  private async versionChanged(requestEpoch: number): Promise<never> {
    if (requestEpoch === this.epoch) {
      this.epoch++;
      this.invalidating = this.invalidate();
    }
    await this.invalidating;
    throw versionChanged();
  }

  private async invalidate(): Promise<void> {
    const previous = this.pin;
    for (const fn of this.beforeListeners) fn();
    this.cache.clear();
    this.pin = undefined;
    this.handle = undefined;
    this.bootstrapPromise = undefined;
    const handle = await this.bootstrap();
    const event: InvalidationEvent = { previous, current: handle.version };
    for (const fn of this.listeners) fn(event);
  }
}

const RETRYABLE = new Set(["server-error", "truncated", "connection-reset"]);
const isAbort = (e: unknown): boolean => e instanceof Error && e.name === "AbortError";
const versionChanged = (): PVecVersionError =>
  new PVecVersionError("version-changed", "the artifact changed while it was being read; caches were dropped and the file re-opened");
