"""Side-by-side 1:1 crops of source vs both variants, for choosing between them.

    python3 compare_variants.py [out.png] [x y]     (x, y in source coordinates)
"""
import sys
import numpy as np
from PIL import Image, ImageDraw
Image.MAX_IMAGE_PIXELS = None
import imgtools as T
import step1_restore as S

dst = sys.argv[1] if len(sys.argv) > 1 else "work/compare.png"
cx, cy = (int(sys.argv[2]), int(sys.argv[3])) if len(sys.argv) > 3 else (505, 105)
SIZE = 460

x0, y0, x1, y1 = S.CROP
src = np.asarray(Image.open(S.SRC).convert("RGB"), dtype=np.float32)[y0:y1, x0:x1] / 255.0

panels = [("SOURCE (0.57 MP)",
           T.resize(src, (src.shape[1] * 4, src.shape[0] * 4), Image.NEAREST))]
for name, path in (("faithful", "out/poster_faithful_4044x2240.jpg"),
                   ("crisp (neural)", "out/poster_crisp_4044x2240.jpg")):
    try:
        panels.append((name, np.asarray(Image.open(path).convert("RGB"),
                                        dtype=np.float32) / 255.0))
    except FileNotFoundError:
        print(f"skipping {name}: {path} not built")

tiles = []
for name, a in panels:
    px = max(0, min(cx * 4 - SIZE // 2, a.shape[1] - SIZE))
    py = max(0, min(cy * 4 - SIZE // 2, a.shape[0] - SIZE))
    im = Image.fromarray((np.clip(a[py:py + SIZE, px:px + SIZE], 0, 1) * 255 + .5)
                         .astype(np.uint8))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, SIZE - 1, 20], fill=(0, 0, 0))
    d.text((5, 5), name, fill=(255, 255, 0))
    tiles.append(np.asarray(im))

Image.fromarray(np.concatenate(tiles, 1)).save(dst)
print(f"-> {dst}  (centred on source pixel {cx},{cy})")
