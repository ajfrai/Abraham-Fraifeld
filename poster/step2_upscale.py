"""Stage 2 - 4x super-resolution with Real-ESRGAN (RRDBNet x4plus).

Runs tiled so peak memory stays bounded.  Tiles are inferred with an
overlap of PAD source pixels and then cropped back to their exact extent,
so neighbouring tiles agree and no seam blending is required.
"""
import os, sys, time
import numpy as np
import torch
from PIL import Image
import rrdbnet

# RealESRGAN_x4plus.pth, from the Real-ESRGAN v0.1.0 release.  Not vendored
# here (67 MB); point ESRGAN_WEIGHTS at a local copy to build this variant.
WEIGHTS = os.environ.get("ESRGAN_WEIGHTS", "RealESRGAN_x4plus.pth")
TILE, PAD, SCALE = 192, 32, 4


def upscale(img, net, tile=TILE, pad=PAD, verbose=True):
    """img: HxWx3 float32 in [0,1], sRGB-encoded. Returns 4H x 4W x 3."""
    h, w, _ = img.shape
    out = np.empty((h * SCALE, w * SCALE, 3), dtype=np.float32)
    ny, nx = (h + tile - 1) // tile, (w + tile - 1) // tile
    t0 = time.time()
    with torch.no_grad():
        for i in range(ny):
            for j in range(nx):
                y0, y1 = i * tile, min((i + 1) * tile, h)
                x0, x1 = j * tile, min((j + 1) * tile, w)
                ey0, ey1 = max(0, y0 - pad), min(h, y1 + pad)
                ex0, ex1 = max(0, x0 - pad), min(w, x1 + pad)
                t = torch.from_numpy(
                    img[ey0:ey1, ex0:ex1].transpose(2, 0, 1)[None].copy())
                o = net(t)[0].clamp(0, 1).numpy().transpose(1, 2, 0)
                cy0, cx0 = (y0 - ey0) * SCALE, (x0 - ex0) * SCALE
                out[y0*SCALE:y1*SCALE, x0*SCALE:x1*SCALE] = \
                    o[cy0:cy0 + (y1-y0)*SCALE, cx0:cx0 + (x1-x0)*SCALE]
                if verbose:
                    n = i * nx + j + 1
                    print(f"  tile {n:3d}/{ny*nx}  {time.time()-t0:6.1f}s",
                          flush=True)
    return out


if __name__ == "__main__":
    src = sys.argv[1]
    dst = sys.argv[2]
    torch.set_num_threads(4)
    net = rrdbnet.load(WEIGHTS)
    img = np.asarray(Image.open(src).convert("RGB"), dtype=np.float32) / 255.0
    print(f"in  {img.shape[1]}x{img.shape[0]}")
    t0 = time.time()
    out = upscale(img, net)
    print(f"out {out.shape[1]}x{out.shape[0]}  in {time.time()-t0:.1f}s")
    np.save(dst, out)
    print(f"-> {dst}")
