// Copied into crates/pvec-testkit/examples/ of a libviprs/pvec checkout by tools/pvec-raster-fixtures.sh.
// Writes synthetic.pvec (three rasters: whole, sparse, and one with a codec the reader does not know), one file per hostile tile
// of pvec's corpus (crates/pvec-testkit/src/raster_hostile.rs) and one per accepted tile, and tiles.json naming each with its rule.
use pvec_components::{Band, PixelFormat, Placement, TileCodec};
use pvec_testkit::raster_file::{line_writer, raster_file, RasterIn};
use pvec_testkit::raster_hostile::{accepted, file, hostile};
use pvec_testkit::tiler::{tiles, Shape};
use std::fmt::Write;
use std::path::PathBuf;

const SHAPE: Shape = Shape { width: 1024, height: 512, tile_edge: 256, channels: 1, bit_depth: 8 };

fn placement(codec: TileCodec) -> Placement {
    Placement {
        pixel_to_source: [0.5, 0.25, 0.125, -0.5, 100.0, 50.0],
        width: 1024,
        height: 512,
        visible_box: [0, 0, 1024, 512],
        tile_edge: 256,
        levels: 3,
        tile_codec: codec,
        pixel_format: PixelFormat::Gray,
        bit_depth: 8,
        opacity: 200,
        band: Band::Overlay,
        layer_index: None,
        source_digest: Some([0x5A; 32]),
        attribution: "survey <1998> & \"co\"".into(),
    }
}

fn main() {
    let dir = PathBuf::from(std::env::args().nth(1).expect("usage: pvec_raster_emit <out-dir>"));
    std::fs::create_dir_all(dir.join("hostile")).unwrap();
    std::fs::create_dir_all(dir.join("accepted")).unwrap();
    let all = tiles(SHAPE, |_, _, _| true);
    let sparse = tiles(SHAPE, |level, col, row| !(level == 2 && (col, row) == (3, 1)));
    let mk = |placement, tiles, inline_levels| RasterIn { placement, tiles, inline_levels, chunk_bytes: 1 << 21 };
    let rasters = vec![
        mk(placement(TileCodec::Png), all.clone(), 1),
        mk(placement(TileCodec::Png), sparse, 0),
        mk(placement(TileCodec::Unknown(9)), all, 0),
    ];
    std::fs::write(dir.join("synthetic.pvec"), raster_file(line_writer(), &rasters, 1 << 20)).unwrap();
    let mut json = String::from("[\n");
    let mut rows = Vec::new();
    for (kind, tiles) in [("hostile", hostile()), ("accepted", accepted())] {
        for t in tiles {
            std::fs::write(dir.join(kind).join(format!("{}.pvec", t.name)), file(&t)).unwrap();
            rows.push(format!("  {{\"kind\": \"{kind}\", \"name\": \"{}\", \"rule\": {}, \"why\": \"{}\"}}", t.name, t.rule.map_or("null".to_string(), |r| format!("\"{r}\"")), t.why.replace('"', "\\\"")));
        }
    }
    write!(json, "{}\n]\n", rows.join(",\n")).unwrap();
    std::fs::write(dir.join("tiles.json"), json).unwrap();
}
