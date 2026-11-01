// Hardware GPU result files (#82). Unlike bench/lib/result.ts these never accept a software
// rasteriser as a hardware number: a run on SwiftShader or llvmpipe is a relative cost. The one
// exception is validateSoftwareResult, for a labelled arm64 Linux container run kept apart.
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
  /** Software GL results only: where it ran, and that there was no GPU behind it. */
  container?: string;
  dpr: number;
  viewport: [number, number];
  timerQuery: boolean;
  /** Raster results: the smallest step of `performance.now` the page saw, in ms. 0.1 in Chromium, 1 where the engine clamps it (WebKit). */
  timerResolutionMs?: number;
  /** Raster results: the host's one-minute load average at the start and end of the run, and its logical cpus. */
  hostLoad?: { start: number; end: number; cpus: number };
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
  /** From addLayer until every range is uploaded and drawn: frames, time, the slowest render and the pool's upload bytes. */
  settle: { frames: number; ms: number; renderMaxMs: number; uploadedBytes: number; maxUploadBytesPerFrame: number };
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
  /** Software entries only. */
  container?: string;
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
  /** Software GL runs (arm64 Linux container, no GPU). Relative costs, never tuning input and never GPU numbers. */
  softwareEntries?: Record<string, BaselineEntry>;
  /** Rasters through the wired layer (#108), real renderers only, keyed like `entries`. */
  rasterEntries?: Record<string, RasterEntry>;
  /** The same run on software GL (linux container, no GPU): relative costs, never tuning input. */
  softwareRasterEntries?: Record<string, RasterEntry>;
}
export interface RasterEntry {
  engine: string;
  arch: string;
  os: string;
  softwareRenderer: boolean;
  /** Software entries only. */
  container?: string;
  browserVersion: string;
  /** The timer step the result was measured with: it decides whether the render budget reads a percentile or the mean. */
  timerResolutionMs?: number;
  hostLoad?: { start: number; end: number; cpus: number };
  source: string;
  raster: RasterRun;
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
  return validateResult(r, false);
}

/** A software GL result: only from a labelled linux container (arm64 or x64, native), and it says it is not a GPU number. */
export function validateSoftwareResult(r: unknown): string[] {
  return validateResult(r, true);
}

function validateResult(r: unknown, software: boolean): string[] {
  const res = r as Partial<HardwareResult> | null;
  const env = res?.environment;
  if (!env) return ["result has no environment block"];
  const errors: string[] = [];
  for (const k of ["host", "os", "cpu", "engine", "browserVersion", "gpuRenderer", "gpuVendor"] as const) {
    if (!env[k]) errors.push(`environment.${k} is missing`);
  }
  if (env.arch !== "arm64" && env.arch !== "x64") errors.push(`environment.arch ${JSON.stringify(env.arch)} must be arm64 or x64, native only`);
  const soft = isSoftwareRenderer(`${env.gpuRenderer ?? ""} ${env.gpuVendor ?? ""}`);
  if (software) {
    if (!soft || env.softwareRenderer !== true) errors.push(`software result needs a software renderer and softwareRenderer true (got ${env.gpuRenderer})`);
    if (!/no GPU/.test(env.container ?? "")) errors.push('environment.container must name the container and say "no GPU"');
    if (!/linux/i.test(env.os ?? "")) errors.push("software results are labelled linux only (arm64 or x64, native)");
  } else if (soft || env.softwareRenderer !== false) {
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
  for (const [key, e] of Object.entries(x.rasterEntries ?? {})) {
    if (isSoftwareRenderer(key) || e.softwareRenderer !== false) errors.push(`${key}: software renderers do not get hardware raster entries`);
    if (e.engine !== key.split(" | ")[1]) errors.push(`${key}: engine ${e.engine} does not match the key`);
    if (!e.source) errors.push(`${key}: source result file missing`);
    if (!e.raster?.decode?.length) errors.push(`${key}: raster entry has no decode table`);
    if (!(typeof e.timerResolutionMs === "number" && e.timerResolutionMs > 0)) errors.push(`${key}: raster entry has no timerResolutionMs`);
  }
  for (const [key, e] of Object.entries(x.softwareRasterEntries ?? {})) {
    if (!isSoftwareRenderer(key) || e.softwareRenderer !== true) errors.push(`${key}: only software renderers go in softwareRasterEntries`);
    if (!/no GPU/.test(e.container ?? "")) errors.push(`${key}: software raster entry needs a container label saying no GPU`);
    if (x.rasterEntries?.[key]) errors.push(`${key}: software raster entry also listed as hardware`);
    if (x.tunedFrom?.includes(key)) errors.push(`${key}: software raster entry cannot be tuning input`);
    if (!e.source) errors.push(`${key}: source result file missing`);
  }
  for (const [key, e] of Object.entries(x.softwareEntries ?? {})) {
    if (!isSoftwareRenderer(key) || e.softwareRenderer !== true) errors.push(`${key}: only software renderers go in softwareEntries`);
    if (!/no GPU/.test(e.container ?? "")) errors.push(`${key}: software entry needs a container label saying no GPU`);
    if (x.entries[key]) errors.push(`${key}: software entry also listed as hardware`);
    if (x.tunedFrom?.includes(key)) errors.push(`${key}: software entry cannot be tuning input`);
    if (!/^[0-9a-f]{64}$/.test(e.snapshot?.sha256 ?? "")) errors.push(`${key}: snapshot hash missing`);
    if (!e.source) errors.push(`${key}: source result file missing`);
  }
  return errors;
}

// Rasters through the harness (#108). The same environment block as every other result, a decode table per codec variant and tile
// size, a texImage2D table per tile size, the wired layer on a real map with the 1e6-segment stroke scene plus one and plus ten
// scans, a two-scan view at 1080p and at 4K against the gpu ceiling, and the first drawing with a raster over a paced link.
export const RASTER_VARIANTS = ["png-gray1", "png-gray8", "png-rgba", "jpeg-gray", "jpeg-rgb", "webp-vp8l"] as const;
export const RASTER_EDGES = [256, 512, 1024] as const;
export type RasterVariant = (typeof RASTER_VARIANTS)[number];
export interface RasterDecodeRow { variant: RasterVariant; edge: number; samples: number; bytes: number; coldMs: number; p50Ms: number; p95Ms: number }
/** `texImage2D` of an RGBA8 bitmap then `finish`; `sub*` is the same bitmap into immutable `texStorage2D` storage with `texSubImage2D`. */
export interface RasterUploadRow { edge: number; samples: number; p50Ms: number; p95Ms: number; subP50Ms?: number; subP95Ms?: number }
export interface RasterSceneRun {
  /** `strokes+0` is the stroke scene alone in the same session, the baseline the render time of the other two is read against. */
  name: "strokes+0" | "strokes+1" | "strokes+10";
  rasters: number;
  durationMs: number;
  segments: number;
  frames: LayerRun["frames"];
  /**
   * JavaScript time inside `layer.render` per frame, with the strokes, the raster pass and decodes running. `p50Ms`, `p95Ms` and `maxMs`
   * are over all recorded frames (comparable with the layer rows of #82). The frames split in two populations: `steady` frames uploaded
   * no tile and carry the budget, `uploadFrames` uploaded at least one and are governed by the upload budget (docs/adr/0009).
   */
  render: {
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
    steady: { frames: number; meanMs: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number; over16_7Ms: number[] };
    /** `over16_7Ms` lists every upload frame that took longer than one 60 fps frame: a hitch is recorded, never averaged away. */
    uploadFrames: { frames: number; share: number; p50Ms: number; p95Ms: number; maxMs: number; over16_7Ms: number[] };
  };
  uploads: { framesWithUploads: number; maxTilesPerFrame: number; maxBytesPerFrame: number; overBudgetFrames: number };
  texture: { peakTextures: number; peakGpuTierBytes: number; gpuBytes: number };
  stateDiffs: number;
  errors: number;
  /** `createImageBitmap` and `Image.decode` calls seen on the main thread. */
  mainThreadDecodes: number;
  /** Optional breakdown: milliseconds the raster renderer spent per phase over the run's frames, and how many frames. */
  phases?: Record<string, number>;
  /** The first 80 frames that uploaded a tile: render ms, tiles, MiB and the renderer's own prepare ms. */
  uploadTrace?: { frame: number; ms: number; tiles: number; mib: number; prepareMs: number }[];
}
export interface RasterFitRun { view: "1080p" | "4k"; deviceSize: [number, number]; rasters: number; gpuBytes: number; peakGpuTierBytes: number; textures: number; levels: number[] }
export interface RasterFirstDrawing { mbit: number; ms: number; bytes: number }
/** A corpus raster case replayed through the layer with rasters on and off: the median of `runs` runs. */
export interface RasterReplayRow { case: string; rasters: "on" | "off"; runs: number; firstDrawingMs: number; p95FrameMs: number; maxFrameMs: number; frames: number }
export interface RasterRun {
  decode: RasterDecodeRow[];
  upload: RasterUploadRow[];
  scenes: RasterSceneRun[];
  fit: RasterFitRun[];
  firstDrawing: RasterFirstDrawing[];
  replay: RasterReplayRow[];
}
export interface RasterResult {
  schema: 1;
  commit: string;
  date: string;
  environment: HardwareEnvironment;
  raster: RasterRun;
}
/**
 * The render budget with rasters (ADR 0009, Budget): main-thread time inside `render` on frames that upload no tile, at the 95th percentile,
 * on every real renderer. Where the engine clamps `performance.now` to 1 ms or coarser (`environment.timerResolutionMs`) the mean is
 * asserted instead, because a percentile of clamped readings cannot be read below about 2 ms. ADR 0005's 1 ms stays the pipeline's number.
 */
export const RASTER_RENDER_STEADY_P95_MS = 1.5;
/** The upload budget of the frozen DEFAULTS (ms), restated here because the harness bundle cannot import the runtime defaults. */
export const RASTER_UPLOAD_BUDGET_MS = 2;
/** Fewer upload frames than this and their p95 is their maximum: the bound is then asserted on the p50, and the hitches are listed. */
export const RASTER_UPLOAD_P95_MIN_FRAMES = 20;
/** One 60 fps frame, ms. */
export const FRAME_60FPS_MS = 16.7;
/** The tile edge of the scenes the harness draws. */
export const RASTER_SCENE_EDGE = 512;

/** A raster result file. `software` selects the labelled-container path; a hardware result may not say software. */
export function validateRasterResult(r: unknown, software: boolean): string[] {
  const res = r as Partial<RasterResult> | null;
  const env = res?.environment;
  if (!env) return ["result has no environment block"];
  const errors: string[] = [];
  for (const k of ["host", "os", "cpu", "engine", "browserVersion", "gpuRenderer", "gpuVendor"] as const) {
    if (!env[k]) errors.push(`environment.${k} is missing`);
  }
  if (env.arch !== "arm64" && env.arch !== "x64") errors.push(`environment.arch ${JSON.stringify(env.arch)} must be arm64 or x64, native only`);
  const soft = isSoftwareRenderer(`${env.gpuRenderer ?? ""} ${env.gpuVendor ?? ""}`);
  if (software) {
    if (!soft || env.softwareRenderer !== true) errors.push(`software result needs a software renderer and softwareRenderer true (got ${env.gpuRenderer})`);
    if (!/no GPU/.test(env.container ?? "")) errors.push('environment.container must name the container and say "no GPU"');
    if (!/linux/i.test(env.os ?? "")) errors.push("software results are labelled linux only (arm64 or x64, native)");
  } else if (soft || env.softwareRenderer !== false) {
    errors.push(`environment says software rendering (${env.gpuRenderer}), numbers are not hardware numbers`);
  }
  if (!(typeof env.timerResolutionMs === "number" && env.timerResolutionMs > 0)) errors.push("environment.timerResolutionMs is missing (the statistic of the render budget is chosen from it)");
  const x = res.raster;
  if (!x) return [...errors, "result has no raster block"];
  if (!x.decode?.length) errors.push("raster.decode table is missing");
  for (const v of RASTER_VARIANTS) for (const e of RASTER_EDGES) {
    const row = x.decode?.find((d) => d.variant === v && d.edge === e);
    if (x.decode?.length && !row) errors.push(`raster.decode has no row for ${v} at ${e}`);
    else if (row && !(finite(row.p50Ms) && finite(row.p95Ms) && finite(row.coldMs) && row.bytes > 0)) errors.push(`raster.decode ${v} at ${e} has a missing number`);
  }
  for (const e of RASTER_EDGES) {
    const row = x.upload?.find((u) => u.edge === e);
    if (!row || !finite(row.p50Ms) || !finite(row.p95Ms)) errors.push(`raster.upload has no texImage2D row for ${e}`);
  }
  for (const [name, n] of [["strokes+1", 1], ["strokes+10", 10]] as const) {
    const s = x.scenes?.find((q) => q.name === name);
    if (!s) { errors.push(`raster.scenes has no ${name} run`); continue; }
    if (s.rasters !== n) errors.push(`raster.scenes ${name} drew ${s.rasters} rasters, not ${n}`);
    if (!(s.durationMs >= MIN_RUN_MS)) errors.push(`raster.scenes ${name} durationMs must be at least ${MIN_RUN_MS} (the 60 s run)`);
    for (const k of ["count", "p50Ms", "p95Ms", "maxMs"] as const) if (!finite(s.frames?.[k])) errors.push(`raster.scenes ${name} frames.${k} is missing`);
    for (const k of ["p50Ms", "p95Ms", "maxMs"] as const) if (!finite(s.render?.[k])) errors.push(`raster.scenes ${name} render.${k} is missing`);
    for (const k of ["meanMs", "p50Ms", "p95Ms", "p99Ms", "maxMs"] as const) if (!finite(s.render?.steady?.[k])) errors.push(`raster.scenes ${name} render.steady.${k} is missing`);
    if (!(s.render?.steady?.frames > 0)) errors.push(`raster.scenes ${name} has no steady frames`);
    for (const k of ["frames", "share", "p50Ms", "p95Ms", "maxMs"] as const) if (!finite(s.render?.uploadFrames?.[k])) errors.push(`raster.scenes ${name} render.uploadFrames.${k} is missing`);
    if (!Array.isArray(s.render?.uploadFrames?.over16_7Ms) || !Array.isArray(s.render?.steady?.over16_7Ms)) errors.push(`raster.scenes ${name} render.*.over16_7Ms (the frames longer than 16.7 ms) is missing`);
    if (!finite(s.uploads?.maxBytesPerFrame) || !finite(s.uploads?.maxTilesPerFrame)) errors.push(`raster.scenes ${name} uploads per frame are missing`);
    if (!(s.texture?.gpuBytes > 0) || !finite(s.texture?.peakGpuTierBytes)) errors.push(`raster.scenes ${name} texture residency is missing`);
    if (s.stateDiffs !== 0) errors.push(`raster.scenes ${name} left GL state behind in ${s.stateDiffs} frame diffs`);
    if (s.errors !== 0) errors.push(`raster.scenes ${name} raised ${s.errors} errors`);
    if (s.mainThreadDecodes !== 0) errors.push(`raster.scenes ${name} decoded ${s.mainThreadDecodes} tiles on the main thread`);
  }
  for (const v of ["1080p", "4k"] as const) {
    const f = x.fit?.find((q) => q.view === v);
    if (!f) { errors.push(`raster.fit has no ${v} view`); continue; }
    if (f.rasters !== 2) errors.push(`raster.fit ${v} drew ${f.rasters} scans, not 2`);
    if (!(f.peakGpuTierBytes <= f.gpuBytes)) errors.push(`raster.fit ${v} went over the gpu ceiling (${f.peakGpuTierBytes} of ${f.gpuBytes})`);
  }
  for (const m of [25, 5]) if (!x.firstDrawing?.some((d) => d.mbit === m && d.ms > 0)) errors.push(`raster.firstDrawing has no ${m} Mbit/s row`);
  for (const c of ["architectural-1e5+1-scan", "architectural-1e5+10-scans"]) for (const on of ["on", "off"] as const) {
    const row = x.replay?.find((q) => q.case === c && q.rasters === on);
    if (!row || !(row.firstDrawingMs > 0) || !finite(row.p95FrameMs) || !finite(row.maxFrameMs) || !(row.frames > 0)) errors.push(`raster.replay has no complete row for ${c} with rasters ${on}`);
  }
  return errors;
}

/**
 * The budget of ADR 0009, asserted on a real renderer's result: steady frames inside `RASTER_RENDER_STEADY_P95_MS` (the mean where the
 * timer resolves 1 ms or coarser), upload frames inside the upload budget's own rule (no frame over the byte budget plus one tile, and
 * render p95 over upload frames at most the steady figure plus the 2 ms upload budget plus the file's own `texImage2D` p95 at the scene's
 * tile size), and the gpu ceiling. Software GL is never asserted.
 */
export function rasterBudgetProblems(r: { raster: RasterRun; environment?: { timerResolutionMs?: number | undefined } }): string[] {
  const out: string[] = [];
  const clamped = (r.environment?.timerResolutionMs ?? 0) >= 1;
  const upload = r.raster.upload.find((u) => u.edge === RASTER_SCENE_EDGE)?.p95Ms ?? Infinity;
  for (const s of r.raster.scenes) {
    if (!(s.rasters > 0)) continue;
    const steady = clamped ? s.render.steady.meanMs : s.render.steady.p95Ms;
    const stat = clamped ? "mean" : "p95";
    if (!(steady <= RASTER_RENDER_STEADY_P95_MS)) out.push(`${s.name}: steady render ${stat} ${steady} ms is over ${RASTER_RENDER_STEADY_P95_MS} ms`);
    const uf = s.render.uploadFrames;
    const enough = uf.frames >= RASTER_UPLOAD_P95_MIN_FRAMES;
    const seen = enough ? uf.p95Ms : uf.p50Ms;
    if (uf.frames > 0 && !(seen <= steady + RASTER_UPLOAD_BUDGET_MS + upload)) {
      out.push(`${s.name}: render ${enough ? "p95" : "p50"} ${seen} ms over upload frames (${uf.frames}) is above ${steady} + ${RASTER_UPLOAD_BUDGET_MS} + ${upload} ms (steady, upload budget, texImage2D p95)`);
    }
    if (s.uploads.overBudgetFrames !== 0) out.push(`${s.name}: ${s.uploads.overBudgetFrames} frames uploaded more than the byte budget plus one tile`);
  }
  for (const f of r.raster.fit) if (!(f.peakGpuTierBytes <= f.gpuBytes)) out.push(`${f.view}: ${f.peakGpuTierBytes} bytes over the ${f.gpuBytes} ceiling`);
  return out;
}

export interface RasterTilesManifest {
  tilesSha256: string;
  tiles: { variant: string; edge: number; sha256: string }[];
}
interface RasterCase { id: string; scans: number; strokes: string; scan: { width: number; height: number; dpi: number; edge: number; tilesSha256: string } }

/** The raster cases of the corpus: one scan and ten scans over the 1e5 architectural strokes, each scan an A0 at 400 dpi, with the manifest digest pinned. */
export function validateRasterCorpus(corpus: { rasterCases?: RasterCase[] }, tiles: RasterTilesManifest): string[] {
  const errors: string[] = [];
  const cases = corpus.rasterCases;
  if (!cases?.length) return ["corpus has no rasterCases"];
  for (const c of cases) {
    if (c.scans !== 1 && c.scans !== 10) errors.push(`${c.id}: scans must be 1 or 10, got ${c.scans}`);
    if (c.scan?.tilesSha256 !== tiles.tilesSha256) errors.push(`${c.id}: digest ${c.scan?.tilesSha256} is not the pinned ${tiles.tilesSha256}`);
    if (!(c.scan?.width > 0 && c.scan?.height > 0 && c.scan?.dpi === 400)) errors.push(`${c.id}: scan needs its pinned size at 400 dpi`);
  }
  for (const v of RASTER_VARIANTS) for (const e of RASTER_EDGES) {
    if (!tiles.tiles.some((t) => t.variant === v && t.edge === e && /^[0-9a-f]{64}$/.test(t.sha256))) errors.push(`manifest has no digest for ${v} at ${e}`);
  }
  return errors;
}
