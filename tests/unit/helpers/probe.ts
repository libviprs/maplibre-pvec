import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The committed boundary-probe module (wasm/probe.wasm): exports pvec_abi_version() = 0. */
export const PROBE_WASM_BYTES = new Uint8Array(readFileSync(join(__dirname, "../../../wasm/probe.wasm")));
