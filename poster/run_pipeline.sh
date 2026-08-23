#!/usr/bin/env bash
# Full poster-prep pipeline.  Run from this directory.
set -euo pipefail
mkdir -p work out

echo "== stage 1: crop + deblock + dering =="
python3 step1_restore.py work/01_restored.png

echo "== stage 2a: faithful 4x (Lanczos + iterative back-projection) =="
python3 step2b_classical.py work/01_restored.png work/02b_classical_4x.npy

echo "== stage 2b: crisp 4x (Real-ESRGAN) =="
if [ -f "${ESRGAN_WEIGHTS:-}" ]; then
  python3 step2_upscale.py work/01_restored.png work/02_esrgan_4x.npy
else
  echo "   (skipped: set ESRGAN_WEIGHTS to RealESRGAN_x4plus.pth to build this variant)"
fi

echo "== stage 3: sharpen, grain, package =="
python3 step3_finish.py work/02b_classical_4x.npy out/poster_faithful_4044x2240
[ -f work/02_esrgan_4x.npy ] && \
  python3 step3_finish.py work/02_esrgan_4x.npy out/poster_crisp_4044x2240

echo "== done =="
ls -la out/
