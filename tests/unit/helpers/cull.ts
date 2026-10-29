import { expect } from 'vitest';
import { type CullOptions, type CullableEntity, isEntityVisible } from '../../../src/render/cull';
import type { TransformPipeline } from '../../../src/transform/screen_error';
import { sourceToDevicePx } from '../../../src/transform/screen_error';

/** Does any dense sample of the stroked curve land inside the viewport (device px)? The pixel-set proxy. */
export function trulyVisible(e: CullableEntity, p: TransformPipeline, samples = 2000): boolean {
  const { width, height, devicePixelRatio: dpr } = p.camera;
  const pad = (e.strokeWidthPx / 2) * dpr;
  for (let i = 0; i <= samples; i++) {
    const t = e.domain[0] + ((e.domain[1] - e.domain[0]) * i) / samples;
    const [x, y] = sourceToDevicePx(p, ...e.point(t));
    if (x >= -pad && x <= width * dpr + pad && y >= -pad && y <= height * dpr + pad) return true;
  }
  return false;
}

/** Throws unless the entity is kept at every camera where it is truly visible. Returns how many were. */
export function expectNeverCulled(e: CullableEntity, cameras: TransformPipeline[], opts: CullOptions = {}): number {
  let visible = 0;
  for (const p of cameras) {
    if (!trulyVisible(e, p)) continue;
    visible++;
    expect(isEntityVisible(e, p, opts), 'culled while visible').toBe(true);
  }
  return visible;
}

/** Count of cameras where a truly visible entity was culled (for mutation checks). */
export function falseCulls(e: CullableEntity, cameras: TransformPipeline[], opts: CullOptions = {}): number {
  return cameras.filter((p) => trulyVisible(e, p) && !isEntityVisible(e, p, opts)).length;
}
