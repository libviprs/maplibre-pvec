// Copied into crates/pvec-bench/examples/ of a libviprs/pvec checkout by tools/spike-real.sh.
// Writes the generated benchmark corpus entries (P8.1) named on the command line as <name>.pvec (the writer's
// default layout) and as <name>-tier0.pvec (a spatial directory and a Tier 0 block per leaf, as benches/progressive.rs
// lays them out, with the same preview budget).
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
            let t0 = pvec_bench::shape::artifact(&shapes, spec.unit(), &producer, Default::default(), Some(max_error)).unwrap();
            std::fs::write(dir.join(format!("{name}-tier0.pvec")), &t0).unwrap();
            println!("{name}-tier0 {}", t0.len());
        }
    }
}
