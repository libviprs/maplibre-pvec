"""Emits the tiles the raster hardware run decodes and uploads (#108). Runs in a throw-away container (tools/raster-bench-tiles.sh).

One scan-like tile per codec variant and per tile edge (256, 512, 1024): pale paper with a little noise, text-like dark marks and a few
long rules, so the entropy coder has real work and the bytes are not a flat colour. The content comes from a seeded generator and the
encoders come from the pinned Pillow, so the bytes are reproducible. The manifest pins each tile's size and sha256 and one digest over
all of them, which the corpus raster cases carry.
"""
import hashlib, io, json, random, sys
from PIL import Image, ImageDraw
import PIL

OUT = sys.argv[1]
EDGES = (256, 512, 1024)
VARIANTS = ("png-gray1", "png-gray8", "png-rgba", "jpeg-gray", "jpeg-rgb", "webp-vp8l")
EXT = {"png": "png", "jpeg": "jpg", "webp": "webp"}


def picture(edge):
    rng = random.Random(edge)
    noise = Image.frombytes("L", (edge, edge), rng.randbytes(edge * edge)).point(lambda v: 226 + (v >> 4))
    d = ImageDraw.Draw(noise)
    for _ in range(edge * 2):
        x, y = rng.randrange(edge), rng.randrange(edge)
        w, h = rng.randrange(2, 9), rng.randrange(3, 12)
        d.rectangle([x, y, x + w, y + h], fill=rng.randrange(10, 70))
    for _ in range(14):
        y = rng.randrange(edge)
        d.line([0, y, edge, y + rng.randrange(-6, 6)], fill=rng.randrange(20, 80), width=rng.randrange(1, 3))
    return noise


def encode(variant, gray):
    codec = variant.split("-")[0]
    buf = io.BytesIO()
    if variant == "png-gray1":
        gray.point(lambda v: 255 if v > 150 else 0).convert("1").save(buf, "PNG")
    elif variant == "png-gray8":
        gray.save(buf, "PNG")
    elif variant == "png-rgba":
        rgb = Image.merge("RGB", (gray, gray.point(lambda v: min(255, v + 4)), gray.point(lambda v: max(0, v - 6))))
        rgb.convert("RGBA").save(buf, "PNG")
    elif variant == "jpeg-gray":
        gray.save(buf, "JPEG", quality=85)
    elif variant == "jpeg-rgb":
        Image.merge("RGB", (gray, gray.point(lambda v: min(255, v + 4)), gray.point(lambda v: max(0, v - 6)))).save(buf, "JPEG", quality=85)
    else:
        Image.merge("RGB", (gray, gray.point(lambda v: min(255, v + 4)), gray.point(lambda v: max(0, v - 6)))).save(buf, "WEBP", lossless=True, quality=60, method=4)
    return codec, buf.getvalue()


tiles = []
for edge in EDGES:
    gray = picture(edge)
    for v in VARIANTS:
        codec, data = encode(v, gray)
        name = f"{v}-{edge}.{EXT[codec]}"
        open(f"{OUT}/{name}", "wb").write(data)
        tiles.append({"variant": v, "edge": edge, "file": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
digest = hashlib.sha256("".join(f"{t['variant']} {t['edge']} {t['sha256']}\n" for t in tiles).encode()).hexdigest()
open(f"{OUT}/raster-tiles.json", "w").write(json.dumps({"pillow": PIL.__version__, "tilesSha256": digest, "tiles": tiles}, indent=2) + "\n")
