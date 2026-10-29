// Produces the large synthetic container at run time, so the repository stays small.
//   node examples/generate-large.mjs [blocks] [blockBytes]
import { buildPvec } from "./lib/fixtures.mjs";

export function generateLarge({ blocks = 4096, blockBytes = 16384 } = {}) {
  const side = Math.ceil(Math.sqrt(blocks));
  const spec = {
    sourceBounds: [0, 0, side * 100, side * 100],
    blocks: Array.from({ length: blocks }, (_, i) => {
      const x = (i % side) * 100;
      const y = Math.floor(i / side) * 100;
      return { cell: i, bounds: [x, y, x + 100, y + 100], size: blockBytes };
    }),
  };
  return buildPvec(spec).bytes;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const bytes = generateLarge({ blocks: Number(process.argv[2] ?? 4096), blockBytes: Number(process.argv[3] ?? 16384) });
  console.log(JSON.stringify({ bytes: bytes.length }));
}
