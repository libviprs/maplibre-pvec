import { type GeoReference, createGeoTransform } from '../../../src/transform/georeference';
import { Epsg4326Adapter } from '../../../src/transform/crs';
import type { Camera } from '../../../src/transform/projection';

const RAD = Math.PI / 180;

/**
 * A realistic metre-based affine calibration anchored at lng/lat: metres to degrees with the
 * cos(lat) correction, plan rotation, optional anisotropy.
 */
export function anchoredGeoRef(opts: {
  lng: number;
  lat: number;
  rotationDeg?: number;
  unit?: GeoReference['unit'];
  anisotropy?: number;
}): GeoReference {
  const r = (opts.rotationDeg ?? 0) * RAD;
  const kLat = 1 / 110_574;
  const kLng = 1 / (111_320 * Math.cos(opts.lat * RAD));
  const an = opts.anisotropy ?? 1;
  const c = Math.cos(r), s = Math.sin(r);
  return {
    kind: 'affine',
    unit: opts.unit ?? 'm',
    calibration: [kLng * c, kLat * s * an, -kLng * s, kLat * c * an, opts.lng, opts.lat],
    crs: Epsg4326Adapter,
  };
}

export const transformOf = (g: GeoReference) => createGeoTransform(g);

export function camera(over: Partial<Camera> & Pick<Camera, 'center' | 'zoom'>): Camera {
  return { bearing: 0, pitch: 0, width: 1024, height: 768, devicePixelRatio: 1, ...over };
}
