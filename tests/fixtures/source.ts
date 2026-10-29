// Isomorphic: runs under Node (Vitest) and in the browser (Playwright pages).
export interface CorpusPin {
  revision: string;
  manifestSha256: string;
  quarantineSha256: string;
  release: { name: string; manifestSha256: string };
  goldRepo: string;
  goldCommit: string;
  remoteBase: string;
}

export interface ArtifactSource {
  read(path: string): Promise<Uint8Array>;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function memorySource(files: Map<string, Uint8Array>): ArtifactSource {
  return {
    async read(path) {
      const b = files.get(path);
      if (!b) throw new Error(`not found: ${path}`);
      return b;
    },
  };
}

export function httpSource(base: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): ArtifactSource {
  return {
    async read(path) {
      const r = await fetchImpl(`${base.replace(/\/$/, "")}/${path}`);
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`);
      return new Uint8Array(await r.arrayBuffer());
    },
  };
}
