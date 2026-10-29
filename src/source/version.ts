import { PVecVersionError } from "./errors";

/**
 * What pins a session to one file: a strong ETag sent back as If-Match, or a URL whose path or
 * query carries a content hash (the URL itself is then the identity, nothing can change under it).
 */
export type VersionIdentity = { kind: "etag"; value: string } | { kind: "immutable-url" };

const HASH_IN_URL = /(^|[^0-9a-f])[0-9a-f]{32,64}([^0-9a-f]|$)/i;

export function isImmutableUrl(url: string): boolean {
  const u = new URL(url);
  return HASH_IN_URL.test(u.pathname) || HASH_IN_URL.test(u.search);
}

export function classifyVersion(url: string, etag: string | null): VersionIdentity {
  const strong = etag !== null && !etag.startsWith("W/");
  if (strong) return { kind: "etag", value: etag };
  if (isImmutableUrl(url)) return { kind: "immutable-url" };
  if (etag === null) {
    throw new PVecVersionError(
      "missing-etag",
      "the origin sent no readable ETag and the URL is not an immutable content-hash URL. Serve a strong ETag and list ETag in Access-Control-Expose-Headers, or publish the artifact under an immutable URL",
    );
  }
  throw new PVecVersionError(
    "weak-etag",
    `the origin sent the weak ETag ${etag} and the URL is not an immutable content-hash URL. A weak ETag cannot pin byte ranges to one file: serve a strong ETag or publish the artifact under an immutable URL`,
  );
}
