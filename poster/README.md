# Poster preparation

Rebuilds a 1024x561 JPEG contact sheet into a print-ready master.

```bash
export ESRGAN_WEIGHTS=/path/to/RealESRGAN_x4plus.pth   # optional, for the crisp variant
./run_pipeline.sh
```

## What was actually wrong with the source

Measured, not assumed. Several first guesses turned out to be wrong, and the
pipeline is shaped by what the measurements actually showed:

| Property | Finding |
|---|---|
| Resolution | 1024x561 = **0.57 MP**. The real problem. |
| Chroma noise | Cb/Cr sigma **0.5 DN** - essentially clean. |
| Flat-area noise | **0.65 DN** over verified-empty backdrop windows. |
| Ringing near edges | **8.9 DN** vs 1.4 DN in flat areas - a **6.3x** excess. |
| Blocking | 8x8 boundary/interior gradient ratio **1.56**. |
| Border | Pure-white strip **12 px** down the right edge (99.98% white). |
| Montage grid | Seams at x = 204, 407, 602, 811 - panels are **204/203/195/209/201** px, *not* uniform. |

Two early readings were misleading and worth recording:

* Backdrop noise first measured at 9-14 DN. That was **hair and the white panel
  numerals contaminating the sample patches**. On windows verified flat
  (gradient p99 < 0.6 DN/px) the backdrop is 0.65 DN. JPEG quantisation had
  already flattened those blocks. A denoiser there had nothing to remove and
  would only have cost detail elsewhere - the first version of stage 1 did
  exactly that and visibly wiped the beard stubble.
* Panel seams look detectable but are not: the brightness step across one is
  9-11 DN while the backdrop noise floor is 8.9 DN, so a detector latches onto
  numerals and hair instead. The seams above came from a full-width scan
  requiring consistent sign agreement down the whole frame.

## Pipeline

**Stage 1 - `step1_restore.py`.** Crops the stray white border. Deblocks
(strength tuned to drive the blockiness ratio to exactly 1.00 - overshooting
past it inverts the artifact). Then derings *only* the quiet zone just outside
strong edges, which is where JPEG puts mosquito noise and, by construction,
holds no real detail. Hair, stubble and fabric weave are excluded and pass
through untouched.

A non-local means was tried for the deringing first and abandoned: it moved
the mosquito figure only 8.66 -> 8.18 DN while costing face detail, because
near an edge every patch is dissimilar and NLM finds nothing to average.

**Stage 2 - two variants.**

* `step2b_classical.py` (**faithful**, the default): progressive 2x Lanczos in
  linear light, each step followed by iterative back-projection so the result
  stays consistent with the source under downsampling. Invents nothing.
  Round-trip error vs the source: **1.6 DN rms**.
* `step2_upscale.py` (**crisp**): Real-ESRGAN x4plus, run tiled. `rrdbnet.py`
  is a minimal RRDBNet so the official weights load without `basicsr`.

**Stage 3 - `step3_finish.py`.** Output sharpening (amount 0.5, chosen by eye
from a sweep - 0.7 upward goes crunchy), held back inside the ring zone so
codec artifacts are not amplified with the detail. Then fine correlated grain
and a triangular dither, because the source's flat areas are almost perfectly
smooth and that is exactly what bands when a backdrop is printed a metre wide.

## Output

`out/poster_faithful_4044x2240.{tif,jpg}` and `poster_crisp_...` -
16-bit LZW TIFF master plus a quality-96 4:4:4 JPEG proof, both tagged 300 DPI
with an embedded sRGB profile.

Print size from the 4044 x 2240 master:

| DPI | Size | Use |
|---|---|---|
| 300 | 13.5" x 7.5" | small poster, inspected close up |
| 200 | 20.2" x 11.2" | |
| 150 | **27.0" x 14.9"** | standard large-format poster |
| 120 | 33.7" x 18.7" | viewed from a couple of metres |
| 100 | 40.4" x 22.4" | wall-sized, viewed from a distance |

## Which variant to print

**Faithful** is the default and the right choice for most uses. **Crisp** is
visibly sharper at a distance, but Real-ESRGAN reconstructs facial detail
rather than recovering it - on this image it redraws the eyes and eyebrows and
smooths skin toward an airbrushed look. For a poster of a real person that is
a meaningful change to how he looks. Compare the two at 100% before choosing.

## Known source defects, not fixed

The ten variants were made by compositing hair and facial hair onto one base
headshot, and some of that compositing is visible. Panel 3 has a faint
rectangular patch boundary around the goatee (near x=495, y=128 in source
coordinates); a scan for steps sitting inside otherwise-smooth regions finds
about nine such candidates, mostly 2-4 DN in the suit shading.

These are content defects rather than resolution defects and enlargement makes
them more obvious. They are deliberately **not** repaired here: they sit in
textured facial areas where automated patching would do more visible harm than
the seams themselves. Retouching them is a manual job.

No upscaler adds information that was not captured. Going beyond 4x would just
resample these same pixels - if the original camera file still exists,
starting from it will beat anything done here.
