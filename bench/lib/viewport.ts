// Deterministic viewport scripts. The same case id always gives the same script, so two runs
// (and two machines) replay the same camera moves. Zoom stays inside the v1 envelope (22).
export interface ViewportScript {
  start: { center: [number, number]; zoom: number; bearing: number; pitch: number };
  zoomLadder: number[];
  panPath: [number, number][];
  bearingSteps: number[];
  pitchSteps: number[];
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

export function viewportScript(caseId: string): ViewportScript {
  // Pan radius in CSS px comes from the id so cases differ a little but never between runs.
  const radius = 160 + (fnv1a(caseId) % 5) * 20;
  const panPath: [number, number][] = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * 2 * Math.PI;
    panPath.push([Math.round(radius * Math.cos(a)), Math.round(radius * Math.sin(a))]);
  }
  return {
    start: { center: [0, 0], zoom: 14, bearing: 0, pitch: 0 },
    zoomLadder: [14, 16, 18, 20, 22],
    panPath,
    bearingSteps: [0, 15, 30, 45, 0],
    pitchSteps: [0, 30, 60, 0],
  };
}
