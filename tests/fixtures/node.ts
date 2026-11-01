import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { PvecIndex } from "./registry";
import { type ArtifactSource, sha256Hex } from "./source";

export function fsSource(dir: string): ArtifactSource {
  const root = resolve(dir);
  return {
    async read(path) {
      const p = resolve(root, path);
      if (!p.startsWith(root + sep)) throw new Error(`path escapes the corpus root: ${path}`);
      return new Uint8Array(await readFile(p));
    },
  };
}

// Fetch one artifact from the pinned remote, check it against the hash the frozen manifest
// gives, and keep it in the git-ignored cache. A cached copy is re-hashed on every use.
export async function fetchVerified(opts: {
  remote: ArtifactSource;
  path: string;
  sha256: string;
  cacheDir: string;
}): Promise<Uint8Array> {
  const file = join(opts.cacheDir, opts.sha256);
  try {
    const hit = new Uint8Array(await readFile(file));
    if ((await sha256Hex(hit)) === opts.sha256) return hit;
  } catch {
    /* not cached */
  }
  const bytes = await opts.remote.read(opts.path);
  const got = await sha256Hex(bytes);
  if (got !== opts.sha256) throw new Error(`hash mismatch for ${opts.path}: got ${got}, pinned ${opts.sha256}`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return bytes;
}

/** Reads tests/fixtures/pvec/index.json and re-hashes every artifact it lists, so the bytes cannot drift from it. */
export async function loadPvecIndex(dir: string): Promise<PvecIndex> {
  const index = JSON.parse(await readFile(join(dir, "index.json"), "utf8")) as PvecIndex;
  for (const [id, a] of Object.entries(index.artifacts)) {
    const got = await sha256Hex(new Uint8Array(await readFile(join(dir, `${id}.pvec`))));
    if (got !== a.sha256) throw new Error(`${id}.pvec hash ${got} differs from the pinned ${a.sha256}`);
  }
  return index;
}
