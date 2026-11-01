// Browser side of the map examples: a MapLibre map from the page's own style (no tile service, no key), the layer from the
// packed package, and waits that follow the layer's own state rather than a timer.
export const BG = "#dfe7ee";

export async function openMap(container, center, zoom) {
  const map = new maplibregl.Map({
    container, center, zoom, interactive: false, fadeDuration: 0, attributionControl: false, preserveDrawingBuffer: true,
    style: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": BG } }] },
  });
  await new Promise((r) => map.once("load", r));
  return map;
}

/** Resolves after `n` more rendered frames, asking for each one. */
export function frames(map, n) {
  return new Promise((resolve) => {
    const step = () => (n-- <= 0 ? resolve() : (map.once("render", step), map.triggerRepaint()));
    step();
  });
}

/** Renders until `done()` holds. A run that never gets there is ended by the runner's timeout, not by a sleep here. */
export function until(map, done) {
  return new Promise((resolve) => {
    const step = () => (done() ? resolve() : (map.once("render", step), map.triggerRepaint()));
    step();
  });
}

/** The raster tiles of the first level are decoded and on the GPU. */
export const rastersDrawn = (layer) => () => {
  const r = layer.getDiagnostics().rasters;
  return layer.rasters().length > 0 && r.textureBytes > 0 && r.decodesInFlight === 0;
};

/** RGBA at a CSS pixel of the map canvas, read from a copy taken at the end of a frame. */
export function snapshot(map) {
  const c = document.createElement("canvas");
  const src = map.getCanvas();
  c.width = src.width;
  c.height = src.height;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.drawImage(src, 0, 0);
  const dpr = src.width / src.clientWidth;
  return (cssX, cssY) => Array.from(x.getImageData(Math.round(cssX * dpr), Math.round(cssY * dpr), 1, 1).data);
}

/** An 8 by 6 lattice of CSS pixels inside the 640 by 480 map, each with the lng/lat under it. */
export function lattice(map) {
  const out = [];
  for (const fy of [0.1, 0.25, 0.4, 0.55, 0.7, 0.85]) for (const fx of [0.06, 0.19, 0.32, 0.45, 0.58, 0.71, 0.84, 0.94]) {
    const [cssX, cssY] = [Math.round(640 * fx), Math.round(480 * fy)];
    const ll = map.unproject([cssX, cssY]);
    out.push({ cssX, cssY, lng: ll.lng, lat: ll.lat });
  }
  return out;
}
