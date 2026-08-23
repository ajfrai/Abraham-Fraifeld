"""Stage 3 - finishing and print packaging.

Output sharpening is deliberately modest and is held back inside the JPEG
ring zone, so the codec's mosquito noise is not amplified along with real
detail.  A little correlated grain goes on last: the source's flat areas are
almost perfectly noiseless (JPEG quantised them away), and perfectly smooth
gradients are exactly what banding shows up in once a backdrop is printed a
metre wide.
"""
import sys, time
import numpy as np
import tifffile
from PIL import Image, ImageCms
import imgtools as T

SHARPEN, RADIUS, GRAIN_DN = 0.5, 1.1, 0.8


def finish(arr, sharpen=SHARPEN, radius=RADIUS, grain_dn=GRAIN_DN, seed=7):
    """arr: HxWx3 float, sRGB-encoded, in [0,1]."""
    ycc = T.rgb_to_ycc(arr.astype(np.float32))
    Y = ycc[..., 0]

    zone, _ = T.ring_zone(Y, reach=9 * 4, scale=1.5 * 4)   # zone at 4x scale
    Ys = T.unsharp(Y, radius=radius, amount=sharpen, clamp=True)
    Y = Y + (Ys - Y) * (1.0 - 0.7 * zone)

    rng = np.random.default_rng(seed)
    Y = Y + T.grain(Y.shape, rng, grain_dn / 255.0, correlation=1.1)

    ycc[..., 0] = Y
    return np.clip(T.ycc_to_rgb(ycc), 0.0, 1.0)


def save_prints(rgb, stem, dpi=300, seed=11):
    """16-bit TIFF master (no generation loss) + an 8-bit JPEG proof."""
    srgb = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    h, w = rgb.shape[:2]

    # PIL cannot write 16-bit RGB TIFF, so tifffile does it, carrying the
    # resolution tags and the sRGB profile (tag 34675) the print shop needs.
    u16 = (np.clip(rgb, 0, 1) * 65535.0 + 0.5).astype(np.uint16)
    tifffile.imwrite(
        f"{stem}.tif", u16, photometric="rgb", compression="lzw",
        resolution=(dpi, dpi), resolutionunit="INCH",
        extratags=[(34675, "B", len(srgb), srgb, False)])

    # triangular dither before the 8-bit round, so the backdrop gradient
    # cannot post-erise into visible steps
    rng = np.random.default_rng(seed)
    d = (rng.random(rgb.shape, dtype=np.float32)
         - rng.random(rgb.shape, dtype=np.float32)) / 255.0
    u8 = (np.clip(rgb + d, 0, 1) * 255.0 + 0.5).astype(np.uint8)
    Image.fromarray(u8).save(f"{stem}.jpg", quality=96, subsampling=0,
                             optimize=True, dpi=(dpi, dpi), icc_profile=srgb)
    return w, h


if __name__ == "__main__":
    src, stem = sys.argv[1], sys.argv[2]
    t0 = time.time()
    w, h = save_prints(finish(np.load(src)), stem)
    print(f"{stem}: {w}x{h}  ({time.time()-t0:.1f}s)")
