"""Stage 2 (alternative) - classical 4x upscale, no invented detail.

Progressive 2x Lanczos steps, each followed by iterative back-projection so
the result stays consistent with the source under downsampling.  Resampling
happens in linear light, which keeps edge transitions from darkening.
"""
import sys, time
import numpy as np
from PIL import Image
import imgtools as T

src, dst = sys.argv[1], sys.argv[2]
t0 = time.time()
rgb = np.asarray(Image.open(src).convert("RGB"), dtype=np.float32) / 255.0
lin = T.srgb_to_linear(rgb).astype(np.float32)

cur = lin
for step in range(2):                       # 1024 -> 2048 -> 4096
    h, w = cur.shape[:2]
    up = T.resize(cur, (w * 2, h * 2))
    up = T.back_project(up, cur, iters=8, lam=0.9, damp=0.75)
    cur = np.clip(up, 0.0, None)
    print(f"  step {step+1}: {cur.shape[1]}x{cur.shape[0]}  {time.time()-t0:.1f}s")

# verify consistency: downsampling the result should reproduce the source
back = T.resize(cur, (lin.shape[1], lin.shape[0]))
print(f"round-trip rms vs source: "
      f"{np.sqrt(((T.linear_to_srgb(back)-rgb)**2).mean())*255:.3f} DN")

out = T.linear_to_srgb(cur).astype(np.float32)
np.save(dst, out)
print(f"-> {dst}  ({time.time()-t0:.1f}s)")
