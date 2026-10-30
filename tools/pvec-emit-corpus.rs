// Copied into crates/pvec-testkit/examples/ of a libviprs/pvec checkout by tools/pvec-artifacts.sh.
// Writes <fixture>.pvec for every r0-open fixture the canonical generator (P2.4) can hold, and
// emitted.json with the outcome of every fixture, so a refusal keeps its reason.
use pvec_corpus::Bundle;
use pvec_testkit::generate::{emit, generate_all, Cause};
use std::fmt::Write;
use std::path::PathBuf;

fn main() {
    let dir = PathBuf::from(std::env::args().nth(1).expect("usage: emit_corpus <out-dir>"));
    std::fs::create_dir_all(&dir).unwrap();
    let outcomes = generate_all(&Bundle::vendored().unwrap()).unwrap();
    emit(&dir, &outcomes).unwrap();
    let mut json = String::from("[\n");
    for (i, o) in outcomes.iter().enumerate() {
        let (status, why) = match &o.result {
            Ok(_) => ("EMITTED", String::new()),
            Err(r) => (
                match r.cause {
                    Cause::Quarantined => "QUARANTINED",
                    Cause::NotEmitted => "NOT_EMITTED",
                    Cause::MissingCapability { .. } => "MISSING_CAPABILITY",
                    _ => "REFUSED",
                },
                r.to_string(),
            ),
        };
        let why = why.replace('\\', "\\\\").replace('"', "\\\"");
        write!(json, "  {{\"fixtureId\": \"{}\", \"status\": \"{status}\", \"reason\": \"{why}\"}}", o.fixture).unwrap();
        json.push_str(if i + 1 < outcomes.len() { ",\n" } else { "\n" });
    }
    json.push(']');
    std::fs::write(dir.join("emitted.json"), json).unwrap();
}
