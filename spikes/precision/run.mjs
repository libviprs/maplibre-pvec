// Throwaway spike (M1.4). Display fidelity in device pixels for three GPU coordinate strategies.
// The vertex shader's own float32 output is captured with transform feedback, so there is no
// rasterisation snapping: the number is the position the GPU computed, compared with f64 in JS.
// No mathematical tolerance is defined here; this is a display budget only.
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage();
await page.setContent("<canvas id=c width=512 height=512></canvas>");
const results = { browser: `chromium ${browser.version()}`, renderer: "SwiftShader software GL in a container (no GPU)", ...(await page.evaluate(() => {
  const gl = document.getElementById("c").getContext("webgl2");
  const rend = gl.getExtension("WEBGL_debug_renderer_info");
  const info = { glRenderer: rend ? gl.getParameter(rend.UNMASKED_RENDERER_WEBGL) : "n/a", highpFloatPrecision: gl.getShaderPrecisionFormat(gl.VERTEX_SHADER, gl.HIGH_FLOAT).precision };
  const mk = (src, kind) => ({ src, kind });
  const progs = {};
  const build = (name, vs, nAttr) => {
    const p = gl.createProgram();
    const v = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(v, vs); gl.compileShader(v);
    if (!gl.getShaderParameter(v, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(v));
    const f = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(f, "#version 300 es\nprecision highp float; out vec4 o; void main(){o=vec4(1);}"); gl.compileShader(f);
    gl.attachShader(p, v); gl.attachShader(p, f); gl.transformFeedbackVaryings(p, ["vOut"], gl.SEPARATE_ATTRIBS); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    progs[name] = { p, nAttr };
  };
  build("naive", `#version 300 es
precision highp float; in vec2 a; uniform vec2 uC; uniform float uK; out vec2 vOut; void main(){ vOut = (a - uC) * uK; gl_Position = vec4(0.); }`, 2);
  build("local", `#version 300 es
precision highp float; in vec2 a; uniform vec2 uT; uniform float uK; out vec2 vOut; void main(){ vOut = (a + uT) * uK; gl_Position = vec4(0.); }`, 2);
  build("hilo", `#version 300 es
precision highp float; in vec4 a; uniform vec4 uT; uniform float uK; out vec2 vOut; void main(){ vOut = ((a.xy + uT.xy) + (a.zw + uT.zw)) * uK; gl_Position = vec4(0.); }`, 4);

  const run = (strategy, verts /* Float64Array xy */, O, C, s) => {
    const n = verts.length / 2, fr = Math.fround;
    const pr = progs[strategy]; gl.useProgram(pr.p);
    let attr;
    if (strategy === "naive") { attr = new Float32Array(verts); gl.uniform2f(gl.getUniformLocation(pr.p, "uC"), fr(C[0]), fr(C[1])); }
    else if (strategy === "local") {
      attr = new Float32Array(n * 2); for (let i = 0; i < n; i++) { attr[2 * i] = verts[2 * i] - O[0]; attr[2 * i + 1] = verts[2 * i + 1] - O[1]; }
      gl.uniform2f(gl.getUniformLocation(pr.p, "uT"), O[0] - C[0], O[1] - C[1]);
    } else {
      attr = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) for (let d = 0; d < 2; d++) { const x = verts[2 * i + d] - O[d]; const hi = fr(x); attr[4 * i + d] = hi; attr[4 * i + 2 + d] = x - hi; }
      const t = [O[0] - C[0], O[1] - C[1]], hi = t.map(fr), lo = t.map((x, i) => x - hi[i]);
      gl.uniform4f(gl.getUniformLocation(pr.p, "uT"), hi[0], hi[1], lo[0], lo[1]);
    }
    gl.uniform1f(gl.getUniformLocation(pr.p, "uK"), s * 2 / 512);
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, attr, gl.STATIC_DRAW);
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const loc = gl.getAttribLocation(pr.p, "a"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, pr.nAttr, gl.FLOAT, false, 0, 0);
    const tb = gl.createBuffer(); gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, tb); gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, n * 8, gl.STATIC_READ);
    const tf = gl.createTransformFeedback(); gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, tf); gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, tb);
    gl.enable(gl.RASTERIZER_DISCARD); gl.beginTransformFeedback(gl.POINTS); gl.drawArrays(gl.POINTS, 0, n); gl.endTransformFeedback(); gl.disable(gl.RASTERIZER_DISCARD);
    const out = new Float32Array(n * 2); gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, out);
    [vb, tb].forEach(b => gl.deleteBuffer(b)); gl.deleteVertexArray(vao); gl.deleteTransformFeedback(tf); gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, null);
    return out;
  };

  const geometry = (M) => {
    const E = Math.min(5000, M / 2), O = [M, M];
    const P0 = [M + E + 0.123, M + E + 0.456];
    const seg = [P0[0], P0[1], P0[0] + 0.001, P0[1]];
    const arc = []; for (let i = 0; i < 32; i++) { const a = Math.PI * i / 31; arc.push(P0[0] + 0.001 * Math.cos(a), P0[1] + 0.001 * Math.sin(a)); }
    const span = []; for (let j = -4; j <= 4; j++) span.push(P0[0] + j * E / 4, P0[1] + j * E / 8);
    return { O, P0, E, shapes: { seg1mm: new Float64Array(seg), arc1mm: new Float64Array(arc), spanNurbsControlPoints: new Float64Array(span) } };
  };

  const out = { info, cases: [] };
  for (const M of [1e3, 1e6, 1e7]) {
    const g = geometry(M);
    for (const log2s of [0, 4, 8, 12, 14]) {
      const s = 2 ** log2s;
      for (const strategy of ["naive", "local", "hilo"]) {
        const row = { magnitude: M, chunkOffsetUnits: g.E, pxPerUnit: s, zoomEquivalent: +(Math.log2(s * 156543.03)).toFixed(2), strategy, shapes: {} };
        for (const [name, v] of Object.entries(g.shapes)) {
          let staticMax = 0, jitter = 0, prev = null, lenErr = 0, inView = 0;
          for (let k = 0; k < 64; k++) {
            const C = [g.P0[0] + (0.37 + k * 0.1) / s, g.P0[1] + (0.21 + k * 0.1) / s]; // 0.1 px camera steps
            const o = run(strategy, v, g.O, C, s);
            const errs = [];
            for (let i = 0; i < v.length / 2; i++) {
              const rx = (v[2 * i] - C[0]) * s, ry = (v[2 * i + 1] - C[1]) * s;
              if (Math.abs(rx) > 256 || Math.abs(ry) > 256) { errs.push(null); continue; }
              errs.push([o[2 * i] * 256 - rx, o[2 * i + 1] * 256 - ry]);
            }
            if (k === 0) inView = errs.filter(e => e).length;
            errs.forEach((e, i) => { if (!e) return; staticMax = Math.max(staticMax, Math.hypot(e[0], e[1])); if (prev && prev[i]) jitter = Math.max(jitter, Math.hypot(e[0] - prev[i][0], e[1] - prev[i][1])); });
            if (name === "seg1mm" && errs[0] && errs[1]) { const L = Math.hypot((o[2] - o[0]) * 256, (o[3] - o[1]) * 256); lenErr = Math.max(lenErr, Math.abs(L - 0.001 * s)); }
            prev = errs;
          }
          row.shapes[name] = { verticesInView: inView, staticDeviationPx: staticMax, panJitterPx: jitter, ...(name === "seg1mm" ? { segmentLengthErrorPx: lenErr, idealLengthPx: 0.001 * s } : {}) };
        }
        out.cases.push(row);
      }
    }
  }
  // attribute bytes and upload time for 1e6 vertices
  out.upload = [];
  const N = 1e6;
  for (const [strategy, comps] of [["naive", 2], ["local", 2], ["hilo", 4]]) {
    const data = new Float32Array(N * comps); for (let i = 0; i < data.length; i++) data[i] = i * 0.001;
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); const t = [];
    for (let r = 0; r < 9; r++) { const t0 = performance.now(); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); gl.finish(); t.push(performance.now() - t0); }
    t.shift(); t.sort((a, b2) => a - b2); out.upload.push({ strategy, bytesPerVertex: comps * 4, vertices: N, medianUploadMs: +t[t.length >> 1].toFixed(2) });
  }
  return out;
})) };
await browser.close();
fs.writeFileSync(path.join(here, "results.json"), JSON.stringify(results, null, 2));
const fmt = results.cases.map(c => `${c.magnitude} ${c.pxPerUnit} ${c.strategy} seg:${c.shapes.seg1mm.staticDeviationPx.toExponential(2)}/${c.shapes.seg1mm.panJitterPx.toExponential(2)} arc:${c.shapes.arc1mm.staticDeviationPx.toExponential(2)} span:${c.shapes.spanNurbsControlPoints.staticDeviationPx.toExponential(2)}`);
console.log(results.info, results.upload); console.log(fmt.join("\n"));
