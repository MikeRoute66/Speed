#!/usr/bin/env python3
"""
Auto-crop PNG sprites in `assets/Car Sprites` using the alpha channel.
Saves cropped images to `assets/Car Sprites/cropped/` and writes a
`sprite_metadata.json` file with suggested rotation (0 or 90 degrees)
based on aspect-ratio heuristics.

Usage:
    python3 tools/auto_crop_sprites.py

The script does NOT overwrite originals. It requires Pillow (PIL).
"""
import os
import json
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(__file__))
SPRITES_DIR = os.path.join(ROOT, 'assets', 'Car Sprites')
OUT_DIR = os.path.join(SPRITES_DIR, 'cropped')
META_PATH = os.path.join(SPRITES_DIR, 'sprite_metadata.json')
PADDING = 2

os.makedirs(OUT_DIR, exist_ok=True)

metadata = {}
processed = []
skipped = []

for name in sorted(os.listdir(SPRITES_DIR)):
    if not name.lower().endswith('.png'):
        continue
    src_path = os.path.join(SPRITES_DIR, name)
    try:
        im = Image.open(src_path)
    except Exception as e:
        skipped.append((name, f'open-failed: {e}'))
        continue

    # Ensure RGBA
    if im.mode != 'RGBA':
        im = im.convert('RGBA')

    alpha = im.getchannel('A')
    bbox = alpha.getbbox()
    if not bbox:
        # No non-transparent pixels
        skipped.append((name, 'empty alpha'))
        continue

    left, upper, right, lower = bbox
    # add padding
    left = max(0, left - PADDING)
    upper = max(0, upper - PADDING)
    right = min(im.width, right + PADDING)
    lower = min(im.height, lower + PADDING)

    cropped = im.crop((left, upper, right, lower))

    # Heuristic for orientation suggestion: if tall image, suggest 90 rotation
    w, h = cropped.size
    suggestion = 0
    # If height significantly greater than width, it may be rotated 90deg
    if h > w * 1.2:
        suggestion = 90

    out_path = os.path.join(OUT_DIR, name)
    try:
        cropped.save(out_path)
        processed.append(name)
        metadata[name] = {
            'original_size': [im.width, im.height],
            'cropped_size': [w, h],
            'crop_bbox': [left, upper, right, lower],
            'rotation_suggestion_degrees': suggestion,
            'out_path': os.path.relpath(out_path, ROOT)
        }
    except Exception as e:
        skipped.append((name, f'save-failed: {e}'))

# Write metadata file
try:
    with open(META_PATH, 'w', encoding='utf-8') as f:
        json.dump({'processed': processed, 'skipped': skipped, 'meta': metadata}, f, indent=2)
except Exception as e:
    print('Failed to write metadata:', e)

print('Processed:', len(processed), 'skipped:', len(skipped))
print('Output folder:', OUT_DIR)
print('Metadata file:', META_PATH)

# Helpful note for user
print('\nNotes:')
print('- Cropped images are saved to the `cropped/` subfolder; originals are untouched.')
print('- The script only uses the alpha channel; if images lack alpha, they will be skipped.')
print('- The rotation suggestion is just a heuristic (tall vs wide). Review the files and rotate manually where necessary.')
print('- If you want the script to overwrite originals or auto-rotate, I can update it after you confirm the results.')
