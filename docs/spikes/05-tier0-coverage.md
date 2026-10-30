# Spike 05: complete Tier 0 rendering with bounded-error previews

Spike for M1.5. **Partly run (#80).** The part the shipped evaluator allows is measured. The Tier 0 stream itself is not, and I say so below instead of faking it.

## What ran

Harness `spikes/pvec-real/` (`tools/spike-real.sh`), Chromium 130 on x86_64, the real `pvec-wasm` evaluator and real `.pvec` bytes from pvec's writer: the 22 corpus artifacts plus `architectural-1e5`, `architectural-1e6`, `mep-1e5`, `spline-heavy-1e5` and `pathological-1e3`. Raw numbers: `spikes/pvec-real/results.json`, tables in `docs/benchmark-report.md`.

1. **Preview error accounting.** For each file I tessellated the whole drawing to a reference budget (a ten millionth of the extent for the corpus artifacts, a millionth for the large entries) and then to a preview budget of a tenth, a hundredth and a thousandth of the extent. The measured error is the largest distance between the two polylines in both directions, over every entity for the small files and over 300 sampled entities for the large ones. The declared error is the budget I asked for. **Every preview stayed inside its declared error:** ratios of measured over declared run from 0.13 to 0.96 (`spline-heavy-1e5` 0.96, `architectural-1e6` 0.95, `closed-periodic-001` 0.93), none above 1.
2. **Coverage audit.** For 8 windows per corpus artifact (the full extent and seven seeded smaller ones) and 4 per large entry (the full extent and 25, 5 and 1 percent windows; 1,000,000 entities in the largest), I took the entities whose reference curve meets the window and checked they are all in the batch `query_viewport` returns. **Zero were missing, across 1,438,948 entity-window pairs.** The batch keeps extra entities (it works from bounds), which is allowed and costs only tessellation time.

Both results are about display fidelity: they say a preview is within the budget asked for, not that it is the mathematical curve.

## What did not run

The question M1.5 is named after, whether a complete Tier 0 stream with a declared preview error per deferred entity covers a viewport, needs the Tier 0 stream (`P5.4`) and the spatial directory (`P5.1`) through the WASM interface. `pvec-wasm` ABI 1 exports neither (`libviprs/pvec#201`), and none of the 27 files the writer produced by default has a spatial directory. So the preview representation is still **not** decided by phase 1. ADRs 0001 to 0008 do not depend on it, and `M5.1`, `M5.3` and `M2.6` should not start from an assumption about it. They can use the accounting above as a floor: the evaluator's own previews hold their budget, and the viewport query does not cull what it should keep.

The 8 fixtures pvec does not emit (`libviprs/pvec#200`) are not in these numbers.

## Earlier work this builds on

- The bootstrap cost to reach a complete viewport of bytes is in `docs/spikes/02-range-bootstrap.md`.
- The stroke pipeline previews are drawn with is in `docs/spikes/06-stroke.md`.
