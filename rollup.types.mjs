import { dts } from "rollup-plugin-dts";

const entries = { index: ".types/index.d.ts", style: ".types/style/index.d.ts", text: ".types/text/index.d.ts", hatch: ".types/hatch/index.d.ts", wasm: ".types/wasm/index.d.ts" };
export default { input: entries, output: { dir: "dist", format: "es" }, plugins: [dts()] };
