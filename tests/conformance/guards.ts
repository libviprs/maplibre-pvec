export interface Hit {
  file: string;
  line: number;
  text: string;
}

function scan(file: string, text: string, patterns: RegExp[], skipComments = false): Hit[] {
  const hits: Hit[] = [];
  text.split("\n").forEach((raw, i) => {
    if (skipComments && /^\s*(\/\/|\*|\/\*)/.test(raw)) return;
    if (patterns.some((p) => p.test(raw))) hits.push({ file, line: i + 1, text: raw.trim() });
  });
  return hits;
}

export function findConverterReferences(file: string, text: string): Hit[] {
  return scan(file, text, [/cad[\s_-]*exchanger/i, /open[\s_-]*design/i, /\boda[\s_-]*(file[\s_-]*)?converter/i, /\bodafileconverter/i]);
}

export function findStepParsing(file: string, text: string): Hit[] {
  return scan(file, text, [/ISO-10303-21/, /CARTESIAN_POINT/, /B_SPLINE_CURVE_WITH_KNOTS/, /ADVANCED_BREP_SHAPE/]);
}

// A tolerance literal is a tiny number: exponent notation or a decimal below 0.1. Pixel budgets
// such as 0.25 are display measurements and are not tolerances.
const num = String.raw`(?:0\.0\d*|\d+(?:\.\d*)?[eE][-+]?\d+)`;
export function findToleranceLiterals(file: string, text: string): Hit[] {
  return scan(
    file,
    text,
    [
      new RegExp(String.raw`\.(?:toBeLessThan|toBeLessThanOrEqual|toBeGreaterThan)\(\s*-?${num}`),
      /\.toBeCloseTo\(/,
      /\b\w*(?:eps|epsilon|tol|tolerance|ulp)\w*\s*(?::\s*number\s*)?=\s*-?\d/i,
      /\b(?:eps|epsilon|tol|tolerance)\s*\??:\s*number/,
    ],
    true,
  );
}

export function findExternalHosts(file: string, text: string, allowed: string[]): string[] {
  void file;
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
    const host = m[1]!.toLowerCase();
    if (!allowed.includes(host)) out.push(host);
  }
  return out;
}

/** A JavaScript image codec in the dependency graph: the browser decodes rasters, the add-on never does (ADR 0018). */
export function findImageCodecs(file: string, text: string): Hit[] {
  return scan(
    file,
    text,
    [
      /(?:from|require\(|import\()\s*["'](?:pngjs|upng-js|fast-png|jpeg-js|jpg-js|jpeg-decoder|@jsquash\/[\w-]+|libwebp[\w.-]*|webp-hero|webpjs|image-js|sharp|pica|omggif|utif)["'/]/,
      /\b(?:inflateSync|Inflate)\b.*\b(?:IDAT|IHDR)\b/,
    ],
    true,
  );
}

/** A decode path on the main thread: an `Image` element, or `createImageBitmap` outside src/workers. */
export function findMainThreadDecode(file: string, text: string): Hit[] {
  return scan(file, text, [/\bnew\s+Image\s*\(/, /\bHTMLImageElement\b/, /\bcreateImageBitmap\s*\(/, /\bImageDecoder\b/, /\bdocument\.createElement\(\s*["']img["']\s*\)/], true);
}
