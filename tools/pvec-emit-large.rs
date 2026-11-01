// Copied into crates/pvec-bench/examples/ of a libviprs/pvec checkout by tools/spike-real.sh.
// Writes the generated benchmark corpus entries (P8.1) named on the command line as <name>.pvec (the writer's
// default layout) and as <name>-tier0.pvec (a spatial directory and a Tier 0 block per leaf, as benches/progressive.rs
// lays them out, with the same preview budget). A leaf holds LEAF entities when that is set, else 1,024
// for the mid-sized entries (named -1e5) and pvec's CELL_CAPACITY (32,768) for the others. A producer chooses the capacity for each file, and
// with 32,768 a 100,000 entity file is four leaves whose boxes overlap, so a 5 percent window reads 97 percent of it; with 1,024 it is 97
// leaves and the same window reads 20 percent (libviprs/maplibre-pvec#125).
use pvec_bench::progressive_bench::{PREVIEW_BUDGET_PX, SCREEN_PX};
use pvec_bench::Spec;

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = std::path::PathBuf::from(args.next().expect("usage: emit_large <out-dir> <entry>..."));
    std::fs::create_dir_all(&dir).unwrap();
    for name in args {
        let bytes = pvec_bench::build(&name).unwrap();
        std::fs::write(dir.join(format!("{name}.pvec")), &bytes).unwrap();
        println!("{name} {}", bytes.len());
        if let Some(spec) = Spec::named(&name) {
            let shapes = spec.shapes();
            let (_, all) = pvec_bench::shape::summarise(&shapes);
            let max_error = PREVIEW_BUDGET_PX * (all[2] - all[0]).max(all[3] - all[1]) / SCREEN_PX;
            let producer = format!("{}/{}/{:#x}/tier0", pvec_bench::GENERATOR, spec.name, spec.seed);
            let leaf = std::env::var("LEAF").ok().and_then(|v| v.parse::<u32>().ok()).or_else(|| name.ends_with("-1e5").then_some(1024));
            let t0 = match leaf {
                Some(leaf) => pvec_bench::shape::artifact_at(&shapes, spec.unit(), &producer, Default::default(), Some(max_error), leaf, &[]).unwrap(),
                None => pvec_bench::shape::artifact(&shapes, spec.unit(), &producer, Default::default(), Some(max_error)).unwrap(),
            };
            std::fs::write(dir.join(format!("{name}-tier0.pvec")), &t0).unwrap();
            println!("{name}-tier0 {}", t0.len());
        }
    }
}
