import type { Server } from "node:http";
export function createOrigin(opts: { corpusDir: string; appDir?: string }): Server;
