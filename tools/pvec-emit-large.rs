// Copied into crates/pvec-bench/examples/ of a libviprs/pvec checkout by tools/pvec-large.sh.
// Writes the generated benchmark corpus entries (P8.1) named on the command line as <name>.pvec.
fn main() {
    let mut args = std::env::args().skip(1);
    let dir = std::path::PathBuf::from(args.next().expect("usage: emit_large <out-dir> <entry>..."));
    std::fs::create_dir_all(&dir).unwrap();
    for name in args {
        let bytes = pvec_bench::build(&name).unwrap();
        std::fs::write(dir.join(format!("{name}.pvec")), &bytes).unwrap();
        println!("{name} {}", bytes.len());
    }
}
