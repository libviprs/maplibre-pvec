export interface StagedWasm { file: string; verified: boolean; sha256?: string; bytes?: number; abiVersion?: number; commit?: string }
export function resolveStagedWasm(target: string, opts?: { abiVersion?: number; sha256?: string }): StagedWasm;
export function missingRasterExports(file: string, names: string[]): string[];
