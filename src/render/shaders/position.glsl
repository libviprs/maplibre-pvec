// High/low position reconstruction, included by every geometry program.
//
// aPosHigh / aPosLow: the block-local offset (world position minus block origin, computed in f64
// on the CPU) split into an f32 high part and the f32 remainder.
// uOriginHigh / uOriginLow: the split of (camera - blockOrigin), also computed in f64 on the CPU.
//
// The two subtractions stay small and exact, so the result is the position relative to the camera
// in normalised mercator units without ever forming a large f32 world coordinate.
vec2 pvecCameraRelative(vec2 aPosHigh, vec2 aPosLow, vec2 uOriginHigh, vec2 uOriginLow) {
  return (aPosHigh - uOriginHigh) + (aPosLow - uOriginLow);
}
