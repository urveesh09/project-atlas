"""Pack the baked facade passes into the viewer's wall texture (ADR-103).

    python scripts/facade-textures/pack.py <bake dir> apps/web/src/assets/facade-walls.jpg [--compare]

Needs numpy and Pillow (WebP and AVIF only for --compare). Reads `<id>_{albedo,normal,ao}.npy` written by bake.py and
writes one RGB image of the five layers stacked top to bottom (layer 0 at the top), each a
square tile of one wall material at its real size:

- red is surface brightness as a ratio, 0.5 = 1.0 (unchanged). It is the albedo's luminance
  times its baked occlusion, high-passed so only detail finer than about a tenth of a tile
  remains (broad stains would repeat visibly across a tower; the viewer's weathering map
  already varies tone at that scale), then scaled to the layer's contrast. Its mean is
  exactly 1, so the smallest mip level leaves the lens colour untouched.
- green and blue are the tangent-space normal's x (across) and y (up), 0.5 = flat.
  A tile's normals are re-centred to average flat, as a tiling surface must.

Only brightness and relief are stored: no hue, so the lens colour always reads.
"""

import io
import sys

import numpy as np
from PIL import Image

# Same order as bake.py LAYERS; per-layer brightness contrast.
LAYERS = [
    ("beige_wall_001", 3.0),
    ("red_bricks_04", 0.7),
    ("concrete_wall_003", 0.6),
    ("metal_plate_02", 0.8),
    ("sandstone_blocks_05", 0.75),
]


def blur(a, sigma):
    """Periodic Gaussian blur of a square (n, n) array, by FFT, so the tile still wraps."""
    n = a.shape[0]
    f = np.fft.fftfreq(n)
    g = np.exp(-2 * (np.pi * sigma) ** 2 * (f[:, None] ** 2 + f[None, :] ** 2))
    return np.real(np.fft.ifft2(np.fft.fft2(a) * g))


def layer(src, pid, contrast):
    alb = np.load(f"{src}/{pid}_albedo.npy")
    ao = np.load(f"{src}/{pid}_ao.npy")[..., 0]
    nrm = np.load(f"{src}/{pid}_normal.npy") * 2 - 1
    n = alb.shape[0]
    lum = (alb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)) * ao
    log = np.log(np.maximum(lum, 1e-4))
    detail = (log - blur(log, n / 10)) * contrast
    ratio = np.clip(np.exp(detail), 0.45, 1.55)
    ratio /= ratio.mean()
    x, y = nrm[..., 0] - nrm[..., 0].mean(), nrm[..., 1] - nrm[..., 1].mean()
    out = np.stack([ratio / 2, x * 0.5 + 0.5, y * 0.5 + 0.5], -1)
    return np.clip(np.round(out * 255), 0, 255).astype(np.uint8)


def rooms(src, dest):
    """The 16 rooms from rooms.py as a 4 x 4 atlas, room 0 at the top left (ADR-104).

    Each room's outermost pixel ring is replaced by its neighbours so a bilinear sample at
    a tile's edge never reaches into the next room. Colour, so ordinary 4:2:0 JPEG.
    """
    tiles = []
    for n in range(16):
        t = np.asarray(Image.open(f"{src}/room_{n:02d}.png").convert("RGB")).copy()
        t[0], t[-1], t[:, 0], t[:, -1] = t[1], t[-2], t[:, 1], t[:, -2]
        tiles.append(t)
    rows = [np.concatenate(tiles[r * 4 : r * 4 + 4], 1) for r in range(4)]
    img = Image.fromarray(np.concatenate(rows, 0), "RGB")
    img.save(dest, format="JPEG", quality=85, optimize=True)
    print(f"wrote {dest} {img.size}")


def main():
    if sys.argv[1] == "--rooms":
        return rooms(sys.argv[2], sys.argv[3])
    src, dest = sys.argv[1], sys.argv[2]
    tiles = [layer(src, pid, c) for pid, c in LAYERS]
    atlas = np.concatenate(tiles, 0)
    for (pid, _), t in zip(LAYERS, tiles):
        r = t[..., 0] / 127.5
        print(f"{pid}: brightness mean {r.mean():.4f} sd {r.std():.3f} p1 {np.percentile(r, 1):.2f} p99 {np.percentile(r, 99):.2f}")
    img = Image.fromarray(atlas, "RGB")
    if "--compare" in sys.argv:
        for name, kw in [
            ("png", dict(format="PNG", optimize=True)),
            ("webp lossless", dict(format="WEBP", lossless=True, method=6)),
            ("webp q90", dict(format="WEBP", quality=90, method=6)),
            ("webp q95", dict(format="WEBP", quality=95, method=6)),
            ("jpeg 444 q92", dict(format="JPEG", quality=92, subsampling=0)),
            ("avif 444 q80", dict(format="AVIF", quality=80, subsampling="4:4:4")),
            ("jpeg 444 q85", dict(format="JPEG", quality=85, subsampling=0)),
            ("jpeg 444 q80", dict(format="JPEG", quality=80, subsampling=0)),
        ]:
            buf = io.BytesIO()
            img.save(buf, **kw)
            back = np.asarray(Image.open(io.BytesIO(buf.getvalue())).convert("RGB"), dtype=np.int16)
            err = np.abs(back - atlas.astype(np.int16))
            print(f"{name:14s} {len(buf.getvalue()) / 1024:7.0f} KiB  mean err per channel {err.mean(axis=(0, 1)).round(2).tolist()}  p99 {np.percentile(err, 99, axis=(0, 1)).tolist()}")
    # JPEG without chroma subsampling: every browser decodes it, and unlike lossy WebP
    # (always 4:2:0) it keeps brightness and the two normal channels apart. 380 KiB at q85
    # against 1.8 MiB lossless, with a 99th-percentile error of 17/255 (2026-11-21).
    img.save(dest, format="JPEG", quality=85, subsampling=0, optimize=True)
    print(f"wrote {dest}")


main()
