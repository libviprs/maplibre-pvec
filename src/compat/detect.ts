import { PVecError } from "../source/errors";
import { COMPAT, peerRange } from "./matrix";

const parse = (v: string): [number, number, number] => {
  const [a = 0, b = 0, c = 0] = v.split("-")[0]!.split(".").map(Number);
  return [a, b, c];
};

/** Refuses a MapLibre outside the tested range. Call with `maplibregl.getVersion()` at attach. */
export function assertMapLibreVersion(version: string): void {
  const v = parse(version);
  const lo = parse(COMPAT.maplibre[0]!.version);
  const hi = parse(COMPAT.maplibre[COMPAT.maplibre.length - 1]!.version);
  const below = v[0] < lo[0] || (v[0] === lo[0] && (v[1] < lo[1] || (v[1] === lo[1] && v[2] < lo[2])));
  if (below || v[0] > hi[0]) {
    throw new PVecError("unsupported_maplibre_version", `maplibre-gl ${version} is outside the tested range ${peerRange(COMPAT)}`, { version });
  }
}

/** Refuses anything that is not a WebGL2 context. There is no canvas2D fallback. */
export function assertWebGL2(gl: { constructor: { name: string } } | null | undefined): void {
  if (gl?.constructor?.name !== "WebGL2RenderingContext") {
    throw new PVecError("webgl2_required", "a WebGL2 context is required and there is no canvas2D fallback");
  }
}
