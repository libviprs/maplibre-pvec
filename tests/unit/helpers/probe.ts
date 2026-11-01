import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The committed boundary-probe module (wasm/probe.wasm): exports pvec_abi_version() = 0, which loadEvaluator now refuses. */
export const PROBE_WASM_BYTES = new Uint8Array(readFileSync(join(__dirname, "../../../wasm/probe.wasm")));

/** The evaluator built from libviprs/pvec (wasm/pvec_eval.wasm, pinned by wasm/pvec.pin.json). */
export const EVALUATOR_WASM_BYTES = new Uint8Array(readFileSync(join(__dirname, "../../../wasm/pvec_eval.wasm")));
