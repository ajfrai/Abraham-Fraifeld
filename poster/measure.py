"""Shared measurement helpers, so every stage is judged the same way."""
import numpy as np
from scipy.ndimage import gaussian_filter
import imgtools as T

# 40x40 windows verified empty (gradient p99 < 0.6 DN/px) - two per panel row
EVAL_WINDOWS = [(4,126),(208,50),(413,114),(766,14),(963,10),
                (4,403),(364,403),(413,331),(766,431),(967,379)]


def detrend(p, deg=3):
    h, w = p.shape
    yy, xx = np.mgrid[0:h, 0:w]
    yy, xx = yy / h * 2 - 1, xx / w * 2 - 1
    A = np.stack([(yy**i * xx**j).ravel()
                  for i in range(deg + 1) for j in range(deg + 1 - i)], 1)
    c, *_ = np.linalg.lstsq(A, p.ravel(), rcond=None)
    return p - (A @ c).reshape(h, w)


def backdrop_noise(Y, scale=1):
    """Mottle std (DN) on empty backdrop, split by spatial scale."""
    tot, fine, coarse = [], [], []
    for x, y in EVAL_WINDOWS:
        p = Y[y*scale:(y+40)*scale, x*scale:(x+40)*scale]
        n = detrend(p)
        tot.append(n.std() * 255)
        fine.append((n - gaussian_filter(n, 1.2*scale)).std() * 255)
        coarse.append(gaussian_filter(n, 3.5*scale).std() * 255)
    return np.mean(tot), np.mean(fine), np.mean(coarse)


# face regions used to check that restoration costs no real detail
FACE_CROPS = [(470, 40, 100, 120), (60, 40, 100, 120), (880, 330, 100, 120),
              (470, 330, 100, 120), (270, 40, 100, 120)]


def artifacts(Y):
    """Blockiness ratio, mosquito-noise amplitude, and face detail energy."""
    from scipy.ndimage import gaussian_gradient_magnitude, uniform_filter
    g = gaussian_gradient_magnitude(Y, 1.5) * 255
    hf = Y - gaussian_filter(Y, 1.0)
    edge = g > 15
    near = (uniform_filter(edge.astype(np.float32), 9) > 0.05) & (~edge) & (g < 4)
    far = (uniform_filter(edge.astype(np.float32), 25) < 0.001) & (g < 4)

    gx = np.abs(np.diff(Y, axis=1)) * 255
    cols = np.arange(gx.shape[1])
    fm = far[:, :-1]
    b = gx[:, (cols % 8) == 7][fm[:, (cols % 8) == 7]].mean()
    i = gx[:, (cols % 8) != 7][fm[:, (cols % 8) != 7]].mean()

    detail = np.mean([g[y:y+h, x:x+w].mean() for x, y, w, h in FACE_CROPS])
    return {"block": b / i, "mosquito": hf[near].std() * 255, "detail": detail}
