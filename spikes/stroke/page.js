// Throwaway page code (M1.6). Three stroke strategies over identical geometry.
// Stroke definition for the reference: all points within w/2 of the polyline (round joins, round caps).
window.__stroke = async function () {
  const out = {};
  const cv = document.createElement("canvas"); document.body.appendChild(cv);
  const gl = cv.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error("no webgl2");
  const rend = gl.getExtension("WEBGL_debug_renderer_info");
  out.engine = { ua: navigator.userAgent, glRenderer: rend ? gl.getParameter(rend.UNMASKED_RENDERER_WEBGL) : "n/a", lineWidthRange: Array.from(gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE)) };

  const prog = (vs, fs) => { const p = gl.createProgram(); for (const [t, s] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); gl.attachShader(p, sh); } gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p; };
  const H = "#version 300 es\nprecision highp float;\n";
  const DASH = `float a(float x){ return min(clamp(x+.5,0.,1.),clamp(6.5-x,0.,1.)); }
float dashCov(float s, float period){ if(period<=0.) return 1.; float m=mod(s,period); return max(a(m),a(m-period)); }`;
  const FS_D = H + `in float vD; in float vS; uniform float uHalf, uDash; out vec4 o; ${DASH}
void main(){ float c=clamp(uHalf+.5-abs(vD),0.,1.)*dashCov(vS,uDash); o=vec4(c); }`;
  const FS_S = H + `in vec2 vP; in vec2 vA; in vec2 vB; in float vL0; uniform float uHalf, uDash; out vec4 o; ${DASH}
void main(){ vec2 d=vB-vA; float dd=dot(d,d); float t= dd>0.? clamp(dot(vP-vA,d)/dd,0.,1.):0.; float dist=length(vP-(vA+t*d)); float c=clamp(uHalf+.5-dist,0.,1.)*dashCov(vL0+t*sqrt(dd),uDash); o=vec4(c); }`;
  const VS_INST = (sdf) => H + `in vec2 corner; in vec4 aSeg; in float aL0; uniform vec2 uRes; uniform float uHalf;
${sdf ? "out vec2 vP; out vec2 vA; out vec2 vB; out float vL0;" : "out float vD; out float vS;"}
void main(){ vec2 a=aSeg.xy,b=aSeg.zw,d=b-a; float L=length(d); vec2 dir=L>0.?d/L:vec2(1.,0.); vec2 n=vec2(-dir.y,dir.x); float ext=uHalf+1.;
 float along=mix(-ext,L+ext,corner.x); vec2 p=a+dir*along+n*corner.y*(uHalf+1.);
 ${sdf ? "vP=p;vA=a;vB=b;vL0=aL0;" : "vD=corner.y*(uHalf+1.); vS=aL0+along;"}
 gl_Position=vec4(p/uRes*2.-1.,0.,1.); }`;
  const VS_MESH = H + `in vec2 aPos; in float aD; in float aS; uniform vec2 uRes; out float vD; out float vS; void main(){ vD=aD; vS=aS; gl_Position=vec4(aPos/uRes*2.-1.,0.,1.); }`;
  const P1 = prog(VS_INST(false), FS_D), P3 = prog(VS_INST(true), FS_S), P2 = prog(VS_MESH, FS_D);

  // geometry: polylines as Float64Array xy..., each with start arc length
  const segsOf = (polys) => { const o = []; for (const { pts, L0 } of polys) { let c = L0; for (let i = 0; i + 3 < pts.length; i += 2) { const x0 = pts[i], y0 = pts[i + 1], x1 = pts[i + 2], y1 = pts[i + 3]; o.push([x0, y0, x1, y1, c]); c += Math.hypot(x1 - x0, y1 - y0); } } return o; };
  const buildInstances = (segs) => { const f = new Float32Array(segs.length * 5); segs.forEach((s, i) => f.set(s, i * 5)); return f; };
  const FAN = 6;
  const buildMesh = (polys, h) => {
    const r = h + 1, v = [], idx = [];
    const vert = (x, y, d, s) => { v.push(x, y, d, s); return v.length / 4 - 1; };
    for (const { pts, L0 } of polys) {
      let c = L0; const n = pts.length / 2;
      for (let i = 0; i + 1 < n; i++) {
        const x0 = pts[2 * i], y0 = pts[2 * i + 1], x1 = pts[2 * i + 2], y1 = pts[2 * i + 3]; const L = Math.hypot(x1 - x0, y1 - y0) || 1e-9; const nx = -(y1 - y0) / L, ny = (x1 - x0) / L;
        const q = [vert(x0 + nx * r, y0 + ny * r, r, c), vert(x0 - nx * r, y0 - ny * r, -r, c), vert(x1 + nx * r, y1 + ny * r, r, c + L), vert(x1 - nx * r, y1 - ny * r, -r, c + L)];
        idx.push(q[0], q[1], q[2], q[2], q[1], q[3]);
        // round join/cap fan at the start of every segment, and the end of the polyline
        for (const [px, py, s] of (i === n - 2 ? [[x0, y0, c], [x1, y1, c + L]] : [[x0, y0, c]])) {
          const cen = vert(px, py, 0, s); const ring = []; for (let k = 0; k < FAN; k++) { const a = 2 * Math.PI * k / FAN; ring.push(vert(px + Math.cos(a) * r, py + Math.sin(a) * r, r, s)); }
          for (let k = 0; k < FAN; k++) idx.push(cen, ring[k], ring[(k + 1) % FAN]);
        }
        c += L;
      }
    }
    return { v: new Float32Array(v), i: new Uint32Array(idx) };
  };

  const setup = (w, h, dash) => { cv.width = w; cv.height = h; gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.enable(gl.BLEND); gl.blendEquation(gl.MAX); gl.blendFunc(gl.ONE, gl.ONE); };
  const corners = new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]);
  const drawInst = (P, inst, nSeg, w, h, hw, dash) => {
    gl.useProgram(P); gl.uniform2f(gl.getUniformLocation(P, "uRes"), w, h); gl.uniform1f(gl.getUniformLocation(P, "uHalf"), hw); gl.uniform1f(gl.getUniformLocation(P, "uDash"), dash);
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const cb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, cb); gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW);
    let l = gl.getAttribLocation(P, "corner"); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 2, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, ib); gl.bufferData(gl.ARRAY_BUFFER, inst, gl.STATIC_DRAW);
    l = gl.getAttribLocation(P, "aSeg"); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 4, gl.FLOAT, false, 20, 0); gl.vertexAttribDivisor(l, 1);
    l = gl.getAttribLocation(P, "aL0"); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 1, gl.FLOAT, false, 20, 16); gl.vertexAttribDivisor(l, 1);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nSeg);
    gl.bindVertexArray(null); gl.deleteBuffer(cb); gl.deleteBuffer(ib); gl.deleteVertexArray(vao);
  };
  const drawMesh = (mesh, w, h, hw, dash) => {
    const P = P2; gl.useProgram(P); gl.uniform2f(gl.getUniformLocation(P, "uRes"), w, h); gl.uniform1f(gl.getUniformLocation(P, "uHalf"), hw); gl.uniform1f(gl.getUniformLocation(P, "uDash"), dash);
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, mesh.v, gl.STATIC_DRAW);
    for (const [n, sz, off] of [["aPos", 2, 0], ["aD", 1, 8], ["aS", 1, 12]]) { const l = gl.getAttribLocation(P, n); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, sz, gl.FLOAT, false, 16, off); }
    const eb = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, eb); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.i, gl.STATIC_DRAW);
    gl.drawElements(gl.TRIANGLES, mesh.i.length, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null); gl.deleteBuffer(vb); gl.deleteBuffer(eb); gl.deleteVertexArray(vao);
  };
  const render = (strategy, polys, w, h, width, dash) => {
    setup(w, h); const hw = width / 2; const segs = segsOf(polys);
    if (strategy === "instancedQuad") drawInst(P1, buildInstances(segs), segs.length, w, h, hw, dash);
    else if (strategy === "sdfFragment") drawInst(P3, buildInstances(segs), segs.length, w, h, hw, dash);
    else drawMesh(buildMesh(polys, hw), w, h, hw, dash);
    const px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const cov = new Float32Array(w * h); for (let i = 0; i < w * h; i++) cov[i] = px[4 * i] / 255; return cov;
  };
  const STRATS = ["instancedQuad", "cpuMesh", "sdfFragment"];

  // Supersampled reference: fraction of 16x16 samples within w/2 of the polyline
  const reference = (pts, w, h, width) => {
    const SS = 16, hw = width / 2, ref = new Float32Array(w * h), n = pts.length / 2 - 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let hit = 0;
      for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) {
        const sx = x + (i + .5) / SS, sy = y + (j + .5) / SS; let inside = false;
        for (let k = 0; k < n && !inside; k++) { const ax = pts[2 * k], ay = pts[2 * k + 1], bx = pts[2 * k + 2], by = pts[2 * k + 3], dx = bx - ax, dy = by - ay, dd = dx * dx + dy * dy; const t = dd ? Math.max(0, Math.min(1, ((sx - ax) * dx + (sy - ay) * dy) / dd)) : 0; inside = Math.hypot(sx - ax - t * dx, sy - ay - t * dy) <= hw; }
        if (inside) hit++;
      }
      ref[y * w + x] = hit / (SS * SS);
    }
    return ref;
  };

  // 1. antialiasing and join/cap quality vs reference
  const W = 96, Hh = 96;
  const zig = [10.3, 20.2, 40.7, 70.1, 55.2, 22.9, 80.4, 60.3, 82.1, 61.0, 60.5, 85.8]; // sharp joins, one sub-pixel segment
  out.quality = [];
  for (const width of [1, 2, 8]) {
    const ref = reference(zig, W, Hh, width);
    for (const s of STRATS) {
      const cov = render(s, [{ pts: zig, L0: 0 }], W, Hh, width, 0);
      let sum = 0, sq = 0, n = 0, mx = 0, nearJoinMax = 0;
      const joins = []; for (let k = 1; k < zig.length / 2 - 1; k++) joins.push([zig[2 * k], zig[2 * k + 1]]);
      for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x, r = ref[i], c = cov[i]; if (r === 0 && c === 0) continue;
        const e = Math.abs(r - c); sum += e; sq += e * e; n++; mx = Math.max(mx, e);
        if (joins.some(([jx, jy]) => Math.hypot(x + .5 - jx, y + .5 - jy) <= width / 2 + 2)) nearJoinMax = Math.max(nearJoinMax, e);
      }
      out.quality.push({ strategy: s, widthPx: width, meanAbsCoverageError: +(sum / n).toFixed(4), rmsError: +Math.sqrt(sq / n).toFixed(4), maxError: +mx.toFixed(3), maxErrorNearJoinsAndCaps: +nearJoinMax.toFixed(3), pixelsCompared: n });
    }
  }

  // 2. dash phase continuity across a chunk boundary and joins (straight path split in two chunks)
  out.dash = [];
  {
    const w = 128, h = 16, x0 = 10.3, x1 = 118.7, xb = 64.1, period = 10, y = 8.5, width = 4;
    for (const s of STRATS) {
      const cov = render(s, [{ pts: [x0, y, xb, y], L0: 0 }, { pts: [xb, y, x1, y], L0: xb - x0 }], w, h, width, period);
      const row = (h >> 1) * w; let maxErr = 0, bndErr = 0, interiorErr = 0, lastK = 0; for (let k = 0; x0 + k * period + 8 <= x1; k++) lastK = k;
      for (let k = 0; ; k++) {
        const start = x0 + k * period, end = start + 6; if (end + 2 > x1) break;
        let sw = 0, sx = 0; for (let x = Math.floor(start - 2); x < Math.ceil(start + 8); x++) { const c = cov[row + x]; sw += c; sx += c * (x + .5); }
        const err = Math.abs(sx / sw - (start + 3)); maxErr = Math.max(maxErr, err); if (k > 0 && k < lastK) interiorErr = Math.max(interiorErr, err); if (start < xb + period && end > xb - period) bndErr = Math.max(bndErr, err);
      }
      out.dash.push({ strategy: s, chunkBoundaryX: xb, maxDashCentroidErrorPx: +maxErr.toFixed(4), maxNearChunkBoundaryPx: +bndErr.toFixed(4), maxInteriorDashPx: +interiorErr.toFixed(4) });
    }
  }

  // 3. cost: bytes per segment and frame time at 1e5 and 1e6 segments (software GL: relative cost only)
  out.cost = [];
  const walk = (nSeg, per) => { const polys = []; let seed = 12345; const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let p = 0; p < nSeg / per; p++) { const pts = new Float64Array((per + 1) * 2); pts[0] = r() * 512; pts[1] = r() * 512; for (let i = 1; i <= per; i++) { const a = r() * 6.2832; pts[2 * i] = (pts[2 * i - 2] + Math.cos(a) * 5 + 512) % 512; pts[2 * i + 1] = (pts[2 * i - 1] + Math.sin(a) * 5 + 512) % 512; } polys.push({ pts, L0: 0 }); } return polys; };
  for (const nSeg of [1e5, 1e6]) {
    const polys = walk(nSeg, 100);
    for (const s of STRATS) {
      setup(512, 512);
      const t0 = performance.now(); let bytes, verts, buildMs = 0;
      const chunks = s === "cpuMesh" ? 10 : 1; const per = polys.length / chunks;
      const prepared = [];
      for (let c = 0; c < chunks; c++) {
        const slice = polys.slice(c * per, (c + 1) * per);
        if (s === "cpuMesh") { const tb = performance.now(); const m = buildMesh(slice, 1); buildMs += performance.now() - tb; prepared.push(m); }
        else { const tb = performance.now(); prepared.push(buildInstances(segsOf(slice))); buildMs += performance.now() - tb; }
      }
      if (s === "cpuMesh") { bytes = prepared.reduce((a, m) => a + m.v.byteLength + m.i.byteLength, 0); verts = prepared.reduce((a, m) => a + m.v.length / 4, 0); }
      else { bytes = prepared[0].byteLength + corners.byteLength; verts = 4; }
      const times = [];
      for (let rep = 0; rep < 4; rep++) {
        gl.clear(gl.COLOR_BUFFER_BIT); const tf = performance.now();
        for (const m of prepared) { if (s === "cpuMesh") drawMesh(m, 512, 512, 1, 0); else drawInst(s === "sdfFragment" ? P3 : P1, m, m.length / 5, 512, 512, 1, 0); }
        gl.finish(); const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); times.push(performance.now() - tf);
      }
      times.shift(); times.sort((a, b) => a - b);
      out.cost.push({ strategy: s, segments: nSeg, bytesPerSegment: +(bytes / nSeg).toFixed(1), verticesPerSegment: s === "cpuMesh" ? +(verts / nSeg).toFixed(2) : "4 per instance (shared corner buffer)", cpuBuildMs: +buildMs.toFixed(0), frameMsMedian: +times[1].toFixed(1), frameMsAll: times.map(t => +t.toFixed(1)), width: 2 });
    }
  }
  return out;
};
