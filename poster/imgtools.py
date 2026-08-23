"""Image restoration + upscaling primitives for print preparation.

Everything works on float32 arrays in [0, 1].  Colour ops assume sRGB.
"""
import numpy as np
from PIL import Image
from scipy.ndimage import (uniform_filter, gaussian_filter, maximum_filter,
                           minimum_filter, gaussian_gradient_magnitude)

# ---------------------------------------------------------------- colour ----

def srgb_to_linear(x):
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(x):
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055)


_M_FWD = np.array([[0.299, 0.587, 0.114],
                   [-0.168736, -0.331264, 0.5],
                   [0.5, -0.418688, -0.081312]], dtype=np.float64)
_M_INV = np.linalg.inv(_M_FWD)


def rgb_to_ycc(rgb):
    """sRGB-encoded RGB -> Y in [0,1], Cb/Cr centred on 0."""
    return rgb @ _M_FWD.T.astype(rgb.dtype)


def ycc_to_rgb(ycc):
    return ycc @ _M_INV.T.astype(ycc.dtype)


# ------------------------------------------------------------ resampling ----

def resize(arr, size, filt=Image.LANCZOS):
    """Lanczos resample a float32 HxW or HxWxC array to (w, h). Unclamped."""
    if arr.ndim == 2:
        return np.asarray(
            Image.fromarray(arr.astype(np.float32), mode="F").resize(size, filt),
            dtype=np.float32)
    return np.stack([resize(arr[..., c], size, filt) for c in range(arr.shape[2])], -1)


# -------------------------------------------------------------- deblock -----

def deblock(y, strength=0.6, grid=8):
    """Damp the step discontinuity sitting exactly on JPEG 8x8 block edges.

    Only the component of the edge-crossing gradient that is *not* supported by
    the neighbouring gradients is removed, so real detail landing on a block
    boundary survives.
    """
    out = y.copy()
    for axis in (0, 1):
        a = np.moveaxis(out, axis, 0)
        d = np.diff(a, axis=0)                       # d[i] = a[i+1] - a[i]
        # local gradient context either side of each difference
        ctx = np.empty_like(d)
        ctx[1:-1] = np.minimum(np.abs(d[:-2]), np.abs(d[2:]))
        ctx[0] = np.abs(d[1])
        ctx[-1] = np.abs(d[-2])
        excess = np.sign(d) * np.maximum(np.abs(d) - ctx, 0.0)
        on_grid = ((np.arange(d.shape[0]) % grid) == grid - 1)
        corr = np.zeros_like(d)
        corr[on_grid] = strength * 0.5 * excess[on_grid]
        a[:-1] += corr
        a[1:] -= corr
        out = np.moveaxis(a, 0, axis)
    return out


# -------------------------------------------------------------- sharpen -----

def unsharp(y, radius=1.0, amount=0.6, threshold=0.0, clamp=True):
    """Unsharp mask with local min/max clamping so it cannot ring or halo."""
    blur = gaussian_filter(y, radius)
    hi = y - blur
    if threshold > 0:
        hi = np.sign(hi) * np.maximum(np.abs(hi) - threshold, 0.0)
    out = y + amount * hi
    if clamp:
        r = max(int(round(radius * 2)), 1)
        lo_b = minimum_filter(y, 2 * r + 1)
        hi_b = maximum_filter(y, 2 * r + 1)
        head = (hi_b - lo_b) * 0.12          # allow a little overshoot for bite
        out = np.clip(out, lo_b - head, hi_b + head)
    return out


# ------------------------------------------------ iterative back-projection --

def back_project(hires, lores, iters=8, lam=0.9, damp=0.75):
    """Push `hires` toward consistency with `lores` under Lanczos downsampling.

    Recovers edge acutance that a pure interpolation leaves on the table.  The
    correction is low-passed slightly each round to keep ringing in check.
    """
    hs = (hires.shape[1], hires.shape[0])
    ls = (lores.shape[1], lores.shape[0])
    out = hires.copy()
    for i in range(iters):
        err = lores - resize(out, ls)
        corr = resize(err, hs)
        corr = gaussian_filter(corr, 0.5)
        out = out + (lam * damp ** i) * corr
    return out


# ----------------------------------------------------------------- grain -----

def grain(shape, rng, sigma, correlation=0.8):
    """Spatially-correlated monochrome grain, unit-normalised then scaled."""
    n = rng.standard_normal(shape).astype(np.float32)
    n = gaussian_filter(n, correlation)
    n /= n.std()
    return n * sigma


# ------------------------------------------------------------- ringing ----

def ring_zone(Y, edge_dn=15.0, quiet_dn=4.0, reach=9, scale=1.5):
    """Smooth pixels that sit just outside a strong edge.

    This is where JPEG puts its mosquito noise, and - because the zone
    excludes the high-gradient pixels themselves - it contains no real
    detail to lose.  Denoising here removes the fuzz around hair, collars
    and the panel numerals without touching the hair strands.
    """
    g = gaussian_gradient_magnitude(Y, scale) * 255.0
    strong = (g > edge_dn).astype(np.float32)
    near = uniform_filter(strong, 2 * reach + 1) > 0.05
    zone = (near & (g < quiet_dn)).astype(np.float32)
    return gaussian_filter(zone, 1.5), g
