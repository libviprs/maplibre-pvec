"""Emits the raster fixtures the browser grid decodes (#107). Runs in a throw-away container (tools/raster-fixtures.sh).

Every fixture is a 64 by 64 picture of four flat quadrants, so a lossy codec reproduces the interior of each quadrant, and the
index records the expected RGBA of one sample inside each quadrant (premultiplied where the picture has alpha, which is what the
decoder is asked for). One extra fixture is a 1024 by 1024 progressive JPEG, the largest tile a placement may carry, for the
decode time check.
"""
import hashlib, io, json, struct, sys, zlib
from PIL import Image
import PIL

OUT = sys.argv[1]
N = 64
# four quadrants: top-left, top-right, bottom-left, bottom-right
COLOURS = [(220, 40, 30), (30, 160, 70), (40, 80, 220), (230, 200, 40)]
ALPHAS = [255, 128, 255, 255]
SAMPLES = [(16, 16), (48, 16), (16, 48), (48, 48)]
files = {}


def quad(mode):
    im = Image.new(mode, (N, N))
    px = im.load()
    for y in range(N):
        for x in range(N):
            q = (1 if x >= N // 2 else 0) + (2 if y >= N // 2 else 0)
            r, g, b = COLOURS[q]
            if mode == "L":
                px[x, y] = (r + g + b) // 3
            elif mode == "LA":
                px[x, y] = ((r + g + b) // 3, ALPHAS[q])
            elif mode == "RGB":
                px[x, y] = (r, g, b)
            elif mode == "RGBA":
                px[x, y] = (r, g, b, ALPHAS[q])
            elif mode == "1":
                px[x, y] = 255 if q in (1, 2) else 0
    return im


def rgba_of(mode, q):
    r, g, b = COLOURS[q]
    a = ALPHAS[q]
    if mode == "1":
        v = 255 if q in (1, 2) else 0
        return [v, v, v, 255]
    if mode in ("L", "LA", "JPEG-L"):
        v = (r + g + b) // 3
        r = g = b = v
    if mode in ("L", "RGB", "JPEG-L", "JPEG-RGB"):
        a = 255
    # premultiplied, rounded the way a decoder does
    return [round(r * a / 255), round(g * a / 255), round(b * a / 255), a]


def save(name, im, fmt, kind, mode, tol, **kw):
    buf = io.BytesIO()
    im.save(buf, fmt, **kw)
    data = buf.getvalue()
    files[name] = {
        "bytes": data,
        "meta": {
            "codec": kind,
            "width": im.size[0],
            "height": im.size[1],
            "tolerance": tol,
            "expected": [{"x": x, "y": y, "rgba": rgba_of(mode, i)} for i, (x, y) in enumerate(SAMPLES)],
        },
    }


save("png-gray-1.png", quad("1"), "PNG", "png", "1", 0, bits=1)
save("png-gray-8.png", quad("L"), "PNG", "png", "L", 0)
save("png-gray-alpha-8.png", quad("LA"), "PNG", "png", "LA", 1)
save("png-rgb-8.png", quad("RGB"), "PNG", "png", "RGB", 0)
save("png-rgba-8.png", quad("RGBA"), "PNG", "png", "RGBA", 1)
save("jpeg-gray-baseline.jpg", quad("L"), "JPEG", "jpeg", "JPEG-L", 6, quality=95, progressive=False, subsampling=0)
save("jpeg-rgb-baseline.jpg", quad("RGB"), "JPEG", "jpeg", "JPEG-RGB", 8, quality=95, progressive=False, subsampling=0)
save("jpeg-gray-progressive.jpg", quad("L"), "JPEG", "jpeg", "JPEG-L", 6, quality=95, progressive=True, subsampling=0)
save("jpeg-rgb-progressive.jpg", quad("RGB"), "JPEG", "jpeg", "JPEG-RGB", 8, quality=95, progressive=True, subsampling=0)
save("webp-vp8l.webp", quad("RGB"), "WEBP", "webp", "RGB", 0, lossless=True)
save("webp-vp8.webp", quad("RGB"), "WEBP", "webp", "RGB", 10, lossless=False, quality=95)
# VP8X: extended header, here with an alpha plane (lossless) and with one next to a lossy image
save("webp-vp8x-lossless-alpha.webp", quad("RGBA"), "WEBP", "webp", "RGBA", 1, lossless=True)
save("webp-vp8x-lossy-alpha.webp", quad("RGBA"), "WEBP", "webp", "RGBA", 10, lossless=False, quality=95)


def chunk(t, d):
    c = struct.pack(">I", len(d)) + t + d
    return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)


def with_chunks(png, extra):
    """Insert chunks right after IHDR."""
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    n = struct.unpack(">I", png[8:12])[0]
    end = 8 + 12 + n
    return png[:end] + b"".join(extra) + png[end:]


# Colour chunks that a decoder may apply: with conversion off the pixels must be the stored ones.
base = files["png-rgb-8.png"]
# sRGB with a perceptual intent, and a gamma of 1.0 (a decoder that applied it would brighten every channel a lot)
srgb = with_chunks(base["bytes"], [chunk(b"sRGB", b"\x00"), chunk(b"gAMA", struct.pack(">I", 100000))])
files["png-rgb-8-srgb-gama.png"] = {"bytes": srgb, "meta": {**base["meta"]}}
# an iCCP chunk holding a small matrix profile that is not sRGB (Pillow builds one)
try:
    from PIL import ImageCms
    prof = bytearray(ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes())
    prof[24:36] = b"\0" * 12  # the creation date, so the bytes are reproducible
    prof = bytes(prof)
    icc = b"synthetic\x00\x00" + zlib.compress(prof)
    files["png-rgb-8-iccp.png"] = {"bytes": with_chunks(base["bytes"], [chunk(b"iCCP", icc)]), "meta": {**base["meta"]}}
except Exception as e:  # pragma: no cover
    print("no iccp fixture:", e, file=sys.stderr)

# The decode time check: the largest tile a placement may carry (1024), progressive, with enough entropy to cost something.
import random
rnd = random.Random(7)
big = Image.new("RGB", (1024, 1024))
bp = big.load()
for y in range(1024):
    for x in range(1024):
        n = rnd.randint(-40, 40)
        bp[x, y] = (max(0, min(255, (x // 4) + n)), max(0, min(255, (y // 4) + n)), max(0, min(255, ((x + y) // 8) + n)))
buf = io.BytesIO()
big.save(buf, "JPEG", quality=80, progressive=True, subsampling=0)
files["jpeg-1024-progressive.jpg"] = {"bytes": buf.getvalue(), "meta": {"codec": "jpeg", "width": 1024, "height": 1024, "tolerance": 0, "expected": []}}

index = {"generator": "tools/raster_fixtures.py", "pillow": PIL.__version__, "files": {}}
for name, f in sorted(files.items()):
    open(f"{OUT}/{name}", "wb").write(f["bytes"])
    index["files"][name] = {"bytes": len(f["bytes"]), "sha256": hashlib.sha256(f["bytes"]).hexdigest(), **f["meta"]}
json.dump(index, open(f"{OUT}/index.json", "w"), indent=2)
open(f"{OUT}/index.json", "a").write("\n")
print("wrote", len(files), "fixtures")
