/** Is arc-length position s on an "on" run of the pattern (on, off, on, off...)? */
export function dashOn(s: number, pattern: readonly number[], phase = 0): boolean {
  const total = pattern.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return true;
  let t = (((s + phase) % total) + total) % total;
  for (let i = 0; i < pattern.length; i++) {
    if (t < pattern[i]!) return i % 2 === 0;
    t -= pattern[i]!;
  }
  return true;
}

/** "On" intervals along the cumulative arc length of a polyline, from the same arc attribute the shader reads. */
export function dashRuns(points: ArrayLike<number>, pattern: readonly number[], phase = 0): Array<[number, number]> {
  let length = 0;
  for (let i = 0; i + 3 < points.length; i += 2) length += Math.hypot(points[i + 2]! - points[i]!, points[i + 3]! - points[i + 1]!);
  const total = pattern.reduce((a, b) => a + b, 0);
  const runs: Array<[number, number]> = [];
  if (!(total > 0)) return [[0, length]];
  let pos = -(((phase % total) + total) % total);
  for (let guard = 0; pos < length && guard < 1e7; guard++) {
    for (let i = 0; i < pattern.length && pos < length; i++) {
      const end = pos + pattern[i]!;
      if (i % 2 === 0) { const a = Math.max(pos, 0), b = Math.min(end, length); if (b > a) runs.push([a, b]); }
      pos = end;
    }
  }
  return runs;
}
