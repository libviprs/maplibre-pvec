import { COMPAT, UNSUPPORTED_ROWS, peerRange } from "./matrix";

export function renderCompatibility(c: typeof COMPAT): { markdown: string; json: string } {
  const range = peerRange(c);
  const json =
    JSON.stringify(
      { generatedFrom: "src/compat/matrix.ts", peerDependency: { "maplibre-gl": range }, maplibre: c.maplibre, browsers: c.browsers, browserRequirements: c.browserRequirements, pvec: c.pvec, projections: c.projections, unsupported: UNSUPPORTED_ROWS, experimental: c.experimental },
      null,
      2,
    ) + "\n";
  const row = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;
  const md = [
    "<!-- Generated from src/compat/matrix.ts by npm run compat:generate. Do not edit. -->",
    "# Compatibility",
    "",
    `The \`maplibre-gl\` peer range is \`${range}\`, derived from the lowest and highest tested rows below.`,
    "",
    "## MapLibre GL JS",
    "",
    row(["Version", "render argument", "Context handed to onAdd", "Verified"]),
    row(["---", "---", "---", "---"]),
    ...c.maplibre.map((m) => row([m.version, m.renderArgs, m.context, m.verified])),
    "",
    "## Browsers",
    "",
    row(["Engine", "Status", "Tested", "Note"]),
    row(["---", "---", "---", "---"]),
    ...c.browsers.map((b) => row([b.engine, b.status, b.tested, b.note])),
    "",
    ...Object.entries(c.browserRequirements).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## PVec",
    "",
    `- reader version: ${c.pvec.readerVersion}`,
    `- semantic profile: ${c.pvec.semanticProfile}`,
    `- accepted capability major: ${c.pvec.acceptedCapabilityMajor}`,
    `- required capabilities: ${c.pvec.requiredCapabilities.join(", ")}`,
    `- optional capabilities: ${c.pvec.optionalCapabilities.join(", ")}`,
    "",
    "## Projections",
    "",
    row(["Projection", "State", "Conformance baseline"]),
    row(["---", "---", "---"]),
    ...c.projections.map((p) => row([p.id, p.state, p.baseline ? "yes" : "no"])),
    "",
    "## Unsupported combinations",
    "",
    row(["Row", "Combination", "Code", "Outcome"]),
    row(["---", "---", "---", "---"]),
    ...UNSUPPORTED_ROWS.map((u) => row([u.id, u.combination, `\`${u.code}\``, u.outcome])),
    "",
    "## Experimental (not supported)",
    "",
    ...c.experimental.map((e) => `- ${e.id}: ${e.note}`),
    "",
  ].join("\n");
  return { markdown: md, json };
}
