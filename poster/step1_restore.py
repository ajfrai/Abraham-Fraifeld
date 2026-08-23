"""Stage 1 - repair the JPEG damage in the source before any upscaling.

What is actually wrong with this file, measured rather than assumed:

  * It is 1024x561 (0.57 MP) - far too small for a poster.
  * It carries a stray border: a pure-white strip 12 px wide down the right
    edge (99.98% pure white) plus a stray bottom row.  Printed a metre wide
    that becomes a ~48 px white band along one side, so it is cropped off.
    The montage grid behind it is irregular - the seams sit at x = 204, 407,
    602, 811, so the panels are 204/203/195/209/201 px wide, not the uniform
    204.8 a 5-column layout would suggest.
  * It is JPEG ~q87.  Its quantisation FLATTENS smooth blocks, so the studio
    backdrop is already essentially noiseless (0.65 DN over verified-empty
    windows).  There is no sensor grain here to remove, and running a
    denoiser over flat areas would only cost detail elsewhere.
  * The damage is instead concentrated where the codec had to work:
      - mosquito/ringing noise around strong edges: 8.66 DN vs 1.38 DN in
        flat areas, a 6.3x excess;
      - 8x8 block edges visible in smooth areas: boundary/interior gradient
        ratio 1.56.
    Both are invisible at 1024 px and both become obvious enlarged 4x.

So this stage deblocks, then denoises *only* the quiet ring just outside
strong edges.  High-gradient pixels - hair strands, stubble, fabric weave,
eyelashes - are excluded by construction and pass through untouched.
"""
import os, sys, time
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter
import imgtools as T
import measure

SRC = os.environ.get("SOURCE_IMAGE", "source/contact_sheet.jpg")
OUT = sys.argv[1] if len(sys.argv) > 1 else "work/01_restored.png"
CROP = (0, 0, 1011, 560)          # drops the white right strip + last row
DEBLOCK = 0.45                    # tuned: drives blockiness ratio to 1.00
RING_BLUR = 0.9                   # px; kept light - see stage 3, which also
                                  # holds sharpening back inside this zone


def restore(rgb, deblock=DEBLOCK, ring_blur=RING_BLUR):
    ycc = T.rgb_to_ycc(rgb.astype(np.float32))
    Y = ycc[..., 0]

    Yd = T.deblock(Y, strength=deblock)

    # Deringing.  A non-local means was tried here first and barely moved the
    # mosquito figure (8.66 -> 8.18 DN) while costing face detail: near an
    # edge, patches are all dissimilar, so NLM finds nothing to average.  The
    # ring zone is defined as LOW-gradient pixels, so a small blur is both
    # safer and far more effective - there is no detail there to protect.
    zone, _ = T.ring_zone(Yd)
    Yf = (1.0 - zone) * Yd + zone * gaussian_filter(Yd, ring_blur)

    ycc[..., 0] = Yf
    return np.clip(T.ycc_to_rgb(ycc), 0.0, 1.0), zone


if __name__ == "__main__":
    t0 = time.time()
    full = np.asarray(Image.open(SRC).convert("RGB"), dtype=np.float32) / 255.0
    x0, y0, x1, y1 = CROP
    rgb = full[y0:y1, x0:x1]
    print(f"crop {full.shape[1]}x{full.shape[0]} -> {rgb.shape[1]}x{rgb.shape[0]}"
          f"  (removed stray white border)")
    out, zone = restore(rgb)
    Image.fromarray((out * 255 + 0.5).astype(np.uint8)).save(OUT)

    Y0 = T.rgb_to_ycc(rgb)[..., 0]
    Y1 = T.rgb_to_ycc(out.astype(np.float32))[..., 0]
    print(f"ring zone covers {zone.mean()*100:.1f}% of the frame")
    for nm, Y in (("before", Y0), ("after ", Y1)):
        m = measure.artifacts(Y)
        print(f"{nm}: blockiness={m['block']:.2f}  mosquito={m['mosquito']:.2f} DN"
              f"  face detail={m['detail']:.2f} DN")
    print(f"-> {OUT}  ({time.time()-t0:.1f}s)")
