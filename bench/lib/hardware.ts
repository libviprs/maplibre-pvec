// Hardware GPU result files (#82). Unlike bench/lib/result.ts these never accept a software
// rasteriser: a run on SwiftShader or llvmpipe is a relative cost, not a hardware number.
export interface HardwareEnvironment {
  host: string;
  os: string;
  arch: "arm64" | "x64";
  cpu: string;
  engine: "chromium" | "webkit";
  browserVersion: string;
  gpuRenderer: string;
  gpuVendor: string;
  softwareRenderer: boolean;
  dpr: number;
  viewport: [number, number];
  timerQuery: boolean;
}
export interface UploadPoint { bytes: number; p50Ms: number; p95Ms: number }
/** The same 1e6-segment scene driven through the wired MapLibre custom layer on a real map (#82 addendum). */
export interface LayerRun {
  durationMs: number;
  segments: number;
  /** GL state names the state guard found changed after a frame, summed over the run. */
  stateDiffs: number;
  /** Layer error events plus map errors. */
  errors: number;
  frames: { count: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number; over20Ms: number };
  drawCalls: { perFrame: number };
  /** JavaScript time inside layer.render per frame. */
  cpu: { renderP50Ms: number; renderP95Ms: number; renderMaxMs: number };
  gpu: { frameP50Ms: number; frameP95Ms: number } | null;
  /** Frames from the first draw until every range is uploaded and drawn. */
  settle: { frames: number; ms: number; renderMaxMs: number };
}
export interface HardwareResult {
  schema: 1;
  commit: string;
  date: string;
  environment: HardwareEnvironment;
  frames: { durationMs: number; count: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number; over20Ms: number };
  drawCalls: { perFrame: number; segmentsPerFrame: number };
  cpu: { submitP50Ms: number; submitP95Ms: number; submitMaxMs: number };
  gpu: { frameP50Ms: number; frameP95Ms: number } | null;
  draw1e6: { segments: number; uploadMs: number; syncDrawP50Ms: number; syncDrawP95Ms: number };
  upload: UploadPoint[];
  snapshot: { scene: string; sha256: string };
  layer?: LayerRun;
}
export interface BaselineEntry {
  engine: string;
  arch: string;
  os: string;
  softwareRenderer: boolean;
  browserVersion: string;
  source: string;
  frames: HardwareResult["frames"];
  drawCalls: HardwareResult["drawCalls"];
  cpu: HardwareResult["cpu"];
  gpu: HardwareResult["gpu"];
  draw1e6: HardwareResult["draw1e6"];
  upload: UploadPoint[];
  snapshot: HardwareResult["snapshot"];
  layer?: LayerRun;
}
export interface Baselines {
  schema: 1;
  /** Renderer strings the frozen budgets were tuned from. */
  tunedFrom: string[];
  /** Keyed by the unmasked renderer string, then engine, e.g. "<renderer> | chromium". */
  entries: Record<string, BaselineEntry>;
}

export const MIN_RUN_MS = 60_000;
export const DRAW_SEGMENTS = 1_000_000;

export function isSoftwareRenderer(renderer: string): boolean {
  return /swiftshader|llvmpipe|softpipe|software|microsoft basic render/i.test(renderer);
}

export const baselineKey = (renderer: string, engine: string): string => `${renderer} | ${engine}`;

/** Largest measured upload size whose p95 fits the time budget, 0 when none does. */
export function uploadBytesWithin(curve: UploadPoint[], budgetMs: number): number {
  let best = 0;
  for (const p of curve) if (p.p95Ms <= budgetMs && p.bytes > best) best = p.bytes;
  return best;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

export function validateHardwareResult(r: unknown): string[] {
  const res = r as Partial<HardwareResult> | null;
  const env = res?.environment;
  if (!env) return ["result has no environment block"];
  const errors: string[] = [];
  for (const k of ["host", "os", "cpu", "engine", "browserVersion", "gpuRenderer", "gpuVendor"] as const) {
    if (!env[k]) errors.push(`environment.${k} is missing`);
  }
  if (env.arch !== "arm64" && env.arch !== "x64") errors.push(`environment.arch ${JSON.stringify(env.arch)} must be arm64 or x64, native only`);
  if (isSoftwareRenderer(`${env.gpuRenderer ?? ""} ${env.gpuVendor ?? ""}`) || env.softwareRenderer !== false) {
    errors.push(`environment says software rendering (${env.gpuRenderer}), numbers are not hardware numbers`);
  }
  const f = res.frames;
  if (!f || !(f.durationMs >= MIN_RUN_MS)) errors.push(`frames.durationMs must be at least ${MIN_RUN_MS} (the 60 s run)`);
  for (const k of ["count", "p50Ms", "p95Ms", "p99Ms", "maxMs"] as const) if (!finite(f?.[k])) errors.push(`frames.${k} is missing`);
  if (!finite(res.drawCalls?.perFrame) || !(res.drawCalls.perFrame > 0)) errors.push("drawCalls.perFrame is missing");
  for (const k of ["submitP50Ms", "submitP95Ms", "submitMaxMs"] as const) if (!finite(res.cpu?.[k])) errors.push(`cpu.${k} is missing`);
  if (!res.draw1e6 || res.draw1e6.segments < DRAW_SEGMENTS) errors.push(`draw1e6.segments must be at least 1e6 (${DRAW_SEGMENTS})`);
  if (!res.upload || res.upload.length < 3) errors.push("upload curve needs at least three sizes");
  if (!/^[0-9a-f]{64}$/.test(res.snapshot?.sha256 ?? "")) errors.push("snapshot.sha256 is missing");
  if (res.layer) errors.push(...validateLayerRun(res.layer));
  return errors;
}

function validateLayerRun(l: LayerRun): string[] {
  const errors: string[] = [];
  if (!(l.durationMs >= MIN_RUN_MS)) errors.push(`layer.durationMs must be at least ${MIN_RUN_MS} (the 60 s run)`);
  if (!(l.segments >= DRAW_SEGMENTS)) errors.push(`layer.segments must be at least 1e6 (${DRAW_SEGMENTS})`);
  if (!finite(l.drawCalls?.perFrame) || !(l.drawCalls.perFrame > 0)) errors.push("layer.drawCalls.perFrame is missing");
  for (const k of ["count", "p50Ms", "p95Ms", "p99Ms", "maxMs"] as const) if (!finite(l.frames?.[k])) errors.push(`layer.frames.${k} is missing`);
  for (const k of ["renderP50Ms", "renderP95Ms", "renderMaxMs"] as const) if (!finite(l.cpu?.[k])) errors.push(`layer.cpu.${k} is missing`);
  if (l.stateDiffs !== 0) errors.push(`layer left GL state behind in ${l.stateDiffs} frame diffs`);
  if (l.errors !== 0) errors.push(`layer run raised ${l.errors} errors`);
  return errors;
}

export function validateBaselines(b: unknown): string[] {
  const x = b as Partial<Baselines> | null;
  if (!x || x.schema !== 1 || !x.entries) return ["baselines need schema 1 and entries"];
  const errors: string[] = [];
  for (const [key, e] of Object.entries(x.entries)) {
    const [renderer, engine] = key.split(" | ");
    if (!renderer || !engine) errors.push(`${key}: key must be "<renderer> | <engine>"`);
    if (isSoftwareRenderer(key) || e.softwareRenderer !== false) errors.push(`${key}: software renderers do not get hardware entries`);
    if (e.engine !== engine) errors.push(`${key}: engine ${e.engine} does not match the key`);
    if (!/^[0-9a-f]{64}$/.test(e.snapshot?.sha256 ?? "")) errors.push(`${key}: snapshot hash missing`);
    if (!e.source) errors.push(`${key}: source result file missing`);
  }
  return errors;
}
