/**
 * A coordinate reference system adapter. Adapters are injected so that no projection library
 * becomes a hard dependency of the add-on. `forward` maps CRS-native coordinates to lng/lat in
 * degrees, `inverse` maps back.
 */
export interface CrsAdapter {
  readonly id: string;
  forward(x: number, y: number): [number, number];
  inverse(lng: number, lat: number): [number, number];
}

/** EPSG:4326: native coordinates already are lng/lat degrees, so both directions are identity. */
export const Epsg4326Adapter: CrsAdapter = Object.freeze({
  id: 'EPSG:4326',
  forward: (x: number, y: number): [number, number] => [x, y],
  inverse: (lng: number, lat: number): [number, number] => [lng, lat],
});
