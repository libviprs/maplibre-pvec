// Throwaway worker. STAND-IN tessellation: expands each segment (x0,y0,x1,y1 as f64) into a
// 2-triangle quad of f32 vertices. It is a linear expansion to give the transport something
// realistic to move; it is not ISO curve mathematics and must never leave this spike.
function expand(inp, out) {
  const n = inp.length >> 2, hw = 0.5;
  for (let i = 0; i < n; i++) {
    const x0 = inp[4 * i], y0 = inp[4 * i + 1], x1 = inp[4 * i + 2], y1 = inp[4 * i + 3];
    let dx = x1 - x0, dy = y1 - y0; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const nx = -dy * hw, ny = dx * hw, o = i * 12;
    out[o] = x0 + nx; out[o + 1] = y0 + ny; out[o + 2] = x0 - nx; out[o + 3] = y0 - ny; out[o + 4] = x1 + nx; out[o + 5] = y1 + ny;
    out[o + 6] = x1 + nx; out[o + 7] = y1 + ny; out[o + 8] = x0 - nx; out[o + 9] = y0 - ny; out[o + 10] = x1 - nx; out[o + 11] = y1 - ny;
  }
}
self.onmessage = (e) => {
  const m = e.data;
  if (m.kind === "echo") { // transport probe
    if (m.mode === "transfer") self.postMessage({ id: m.id, buf: m.buf }, [m.buf]);
    else self.postMessage({ id: m.id, buf: m.buf }); // structured clone back
    return;
  }
  if (m.kind === "job") {
    if (m.mode === "shared") {
      expand(new Float64Array(m.inSab), new Float32Array(m.outSab));
      self.postMessage({ id: m.id, done: true });
    } else {
      const inp = new Float64Array(m.buf), out = new Float32Array((inp.length >> 2) * 12);
      expand(inp, out);
      if (m.mode === "transfer") self.postMessage({ id: m.id, out: out.buffer }, [out.buffer]);
      else self.postMessage({ id: m.id, out: out.buffer });
    }
  }
};
