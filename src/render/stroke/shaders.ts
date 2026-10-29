/**
 * Vector stroke pipeline: one instance per 40-byte segment record, 18 vertices per
 * instance and no index buffer. Vertices 0..5 are the body quad, 6..11 the join wedge
 * at the start and 12..17 the join wedge at the end (degenerate when there is no
 * neighbour). Nothing here uses gl.lineWidth.
 *
 * Instance attributes (all from the same buffer, see docs/buffer-model.md):
 *   a_p0, a_p1   vec4  (x_hi, y_hi, x_lo, y_lo)
 *   a_arc        float cumulative arc length at p0
 *   a_meta       uint  widthIndex:12 | dashIndex:12 | flags:8
 *   a_prev       vec4  p0 of the previous record  (bound at byte offset -40, read when HAS_PREV)
 *   a_next       vec4  p1 of the next record      (bound at byte offset +40, read when HAS_NEXT)
 *
 * flags: bit0 HAS_PREV, bit1 HAS_NEXT, bits2-3 cap (0 butt, 1 square, 2 round),
 *        bits4-5 join (0 miter, 1 bevel, 2 round).
 */
export const STROKE_FLAGS = { HAS_PREV: 1, HAS_NEXT: 2, CAP_SHIFT: 2, JOIN_SHIFT: 4 } as const;

export const VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;
in vec4 a_p0;
in vec4 a_p1;
in float a_arc;
in uint a_meta;
in vec4 a_prev;
in vec4 a_next;

uniform vec2 u_centerHi;     // camera centre, high word, source units
uniform vec2 u_centerLo;     // camera centre, low word
uniform mat2 u_linear;       // device px per source unit (includes rotation and y flip)
uniform vec2 u_viewport;     // drawing buffer size in device px
uniform float u_arcToPx;     // device px per unit of arc length (screen or world dash mode)
uniform float u_widthPx[64]; // stroke width in device px per width index
uniform float u_dpr;
uniform float u_miterLimit;

out vec2 v_local;
flat out float v_len;
flat out float v_hw;
flat out vec2 v_joint;
flat out float v_arcPx;
flat out uint v_dash;
flat out uint v_cap;
flat out int v_kind;
flat out uint v_nb;

vec2 rel(vec4 p) { return u_linear * ((p.xy - u_centerHi) + (p.zw - u_centerLo)); }
vec2 perp(vec2 v) { return vec2(-v.y, v.x); }

// Outer corners and tip of a join at joint j between directions t0 (arriving) and t1 (leaving).
void joinTriangle(vec2 j, vec2 t0, vec2 t1, float hw, uint join, int tri, out vec2 p1, out vec2 p2, out int kind) {
  float c = t0.x * t1.y - t0.y * t1.x;
  float dp = dot(t0, t1);
  float s = c > 0.0 ? -1.0 : 1.0;
  vec2 o1 = j + s * perp(t0) * hw;
  vec2 o2 = j + s * perp(t1) * hw;
  float cosHalf = sqrt(max(0.0, (1.0 + dp) * 0.5));
  float ratio = cosHalf > 1e-4 ? 1.0 / cosHalf : 1e4;
  vec2 m = s * (perp(t0) + perp(t1));
  float ml = length(m);
  vec2 tip = o1;
  kind = 1;
  if (ml > 1e-6) {
    if (join == 0u && ratio <= u_miterLimit) { tip = j + (m / ml) * hw * ratio; }
    else if (join == 2u) { tip = j + (m / ml) * hw * min(ratio, 32.0); kind = 2; }
  }
  if (tri == 0) { p1 = o1; p2 = tip; } else { p1 = tip; p2 = o2; }
  if (abs(c) < 1e-6 && dp > 0.0) { p1 = j; p2 = j; }
}

void main() {
  uint flags = a_meta >> 24;
  uint wi = a_meta & 0xfffu;
  uint di = (a_meta >> 12) & 0xfffu;
  float width = u_widthPx[min(wi, 63u)];
  float hw = 0.5 * width;
  float pad = u_dpr;
  vec2 a = rel(a_p0);
  vec2 b = rel(a_p1);
  vec2 d = b - a;
  float len = max(length(d), 1e-6);
  vec2 t = d / len;
  vec2 n = perp(t);
  bool hasPrev = (flags & 1u) != 0u;
  bool hasNext = (flags & 2u) != 0u;
  uint cap = (flags >> 2) & 3u;
  uint join = (flags >> 4) & 3u;
  int id = gl_VertexID;
  vec2 pos = a;
  int kind = 0;
  vec2 jointLocal = vec2(0.0);

  if (id < 6) {
    int k = (id == 0 || id == 3) ? 0 : (id == 1) ? 1 : (id == 2 || id == 4) ? 2 : 3;
    float u = (k == 1 || k == 2) ? 1.0 : 0.0;
    float v = (k == 2 || k == 3) ? 1.0 : -1.0;
    float e0 = hasPrev ? 0.0 : (cap == 0u ? pad : hw + pad);
    float e1 = hasNext ? 0.0 : (cap == 0u ? pad : hw + pad);
    pos = a + t * (u > 0.5 ? len + e1 : -e0) + n * v * (hw + pad);
  } else if (id < 12) {
    if (hasPrev) {
      vec2 tp = normalize(a - rel(a_prev));
      int tri = (id - 6) / 3;
      vec2 q1, q2;
      joinTriangle(a, tp, t, hw, join, tri, q1, q2, kind);
      int w = (id - 6) % 3;
      pos = w == 0 ? a : (w == 1 ? q1 : q2);
      jointLocal = vec2(0.0);
    }
  } else {
    if (hasNext) {
      vec2 tn = normalize(rel(a_next) - b);
      int tri = (id - 12) / 3;
      vec2 q1, q2;
      joinTriangle(b, t, tn, hw, join, tri, q1, q2, kind);
      int w = (id - 12) % 3;
      pos = w == 0 ? b : (w == 1 ? q1 : q2);
      jointLocal = vec2(len, 0.0);
    }
  }
  vec2 rp = pos - a;
  v_local = vec2(dot(rp, t), dot(rp, n));
  v_len = len;
  v_hw = hw;
  v_joint = jointLocal;
  v_arcPx = a_arc * u_arcToPx;
  v_dash = di;
  v_cap = cap;
  v_kind = kind;
  v_nb = flags & 3u;
  gl_Position = vec4(pos / (0.5 * u_viewport), 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_local;
flat in float v_len;
flat in float v_hw;
flat in vec2 v_joint;
flat in float v_arcPx;
flat in uint v_dash;
flat in uint v_cap;
flat in int v_kind;
flat in uint v_nb;

uniform float u_dpr;      // 1 css px of feather, in device px
uniform vec4 u_color;     // straight alpha, black by default
uniform vec4 u_dash[16];  // (on, off, on2, off2) in device px; entry i serves dash index i + 1

out vec4 outColor;

float edge(float sd) { return clamp(0.5 - sd / u_dpr, 0.0, 1.0); }
float within(float t, float lo, float hi) { return min(t - lo, hi - t); }

void main() {
  float cov;
  if (v_kind == 1) {
    cov = 1.0;
  } else if (v_kind == 2) {
    cov = edge(length(v_local - v_joint) - v_hw);
  } else {
    float ax = v_local.x;
    float sdAcross = abs(v_local.y) - v_hw;
    float sd;
    if (v_cap == 2u) {
      float cx = clamp(ax, 0.0, v_len);
      float dx = (ax < 0.0 && (v_nb & 1u) != 0u) || (ax > v_len && (v_nb & 2u) != 0u) ? 0.0 : ax - cx;
      sd = length(vec2(dx, v_local.y)) - v_hw;
    } else {
      float ext = v_cap == 1u ? v_hw : 0.0;
      float sdStart = (v_nb & 1u) != 0u ? -1e3 : -ax - ext;
      float sdEnd = (v_nb & 2u) != 0u ? -1e3 : ax - v_len - ext;
      float sdAlong = max(sdStart, sdEnd);
      sd = max(sdAlong, sdAcross);
    }
    cov = edge(sd);
  }
  if (v_dash > 0u) {
    vec4 p = u_dash[min(v_dash - 1u, 15u)];
    float period = p.x + p.y + p.z + p.w;
    if (period > 0.0) {
      float t = mod(v_arcPx + v_local.x, period);
      float sd1 = within(t, 0.0, p.x);
      float sd2 = p.z > 0.0 ? within(t, p.x + p.y, p.x + p.y + p.z) : -1e3;
      float wrap = within(t - period, 0.0, p.x);
      float inside = max(max(sd1, sd2), wrap);
      cov *= clamp(0.5 + inside / u_dpr, 0.0, 1.0);
    }
  }
  float alpha = cov * u_color.a;
  outColor = vec4(u_color.rgb * alpha, alpha);
}
`;
