#!/usr/bin/env python3
"""Rotate sprite files according to sprite_metadata.json rotation suggestions.
Produces rotated copies into cropped/rotated/ so originals are preserved.
"""
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SPRITES_DIR = ROOT / "assets" / "Car Sprites"
CROPPED_DIR = SPRITES_DIR / "cropped"
ROTATED_DIR = CROPPED_DIR / "rotated"
META_FILE = CROPPED_DIR / "sprite_metadata.json"
if not META_FILE.exists():
    # Older runs wrote metadata to the parent sprites dir; try that as fallback.
    META_FILE = SPRITES_DIR / "sprite_metadata.json"

if not META_FILE.exists():
    print(f"metadata file not found: {META_FILE}")
    raise SystemExit(1)

with META_FILE.open("r", encoding="utf8") as fh:
    meta = json.load(fh)

m = meta.get("meta") or {}
ROTATED_DIR.mkdir(parents=True, exist_ok=True)

processed = 0
skipped = 0
for name, info in m.items():
    deg = info.get("rotation_suggestion_degrees") or 0
    src = Path(info.get("out_path") or (CROPPED_DIR / name))
    if not src.exists():
        # Try fallback to original
        src = SPRITES_DIR / name
        if not src.exists():
            print(f"source not found for {name}, skipping")
            skipped += 1
            continue
    if not deg or deg % 360 == 0:
        skipped += 1
        continue
    out = ROTATED_DIR / name
    try:
        img = Image.open(src).convert("RGBA")
        # Interpret suggestion degrees as clockwise; Pillow.rotate is counter-clockwise
        angle_ccw = -deg
        rotated = img.rotate(angle_ccw, expand=True)
        rotated.save(out)
        print(f"Wrote rotated {out} (rotated {deg}° clockwise)")
        processed += 1
    except Exception as e:
        print(f"Failed to rotate {src}: {e}")
        skipped += 1

print(f"Done. processed={processed}, skipped={skipped}")
