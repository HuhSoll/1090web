"""
Step 2 of the social preview image: draws the geometry exported by export-geometry.mjs.

Routes are accumulated additively (like the app's WebGL layer) so busy corridors glow, then
the frame is supersampled down for smooth lines.

Usage:
  node scripts/og/export-geometry.mjs og.json
  python scripts/og/render-og.py og.json public/og-image.png [path/to/font.ttf]
Requires Pillow and numpy.
"""

import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

S = 2  # supersampling factor

BG_TOP = np.array([5, 11, 22], dtype=np.float32) / 255
BG_BOTTOM = np.array([2, 4, 10], dtype=np.float32) / 255
LAND = np.array([22, 41, 63], dtype=np.float32) / 255
COAST = np.array([93, 147, 191], dtype=np.float32) / 255
ROUTE_LOW = np.array([0.10, 0.42, 0.78], dtype=np.float32)
ROUTE_HIGH = np.array([0.62, 0.92, 1.0], dtype=np.float32)
NOTABLE = np.array([0.85, 0.97, 1.0], dtype=np.float32)
AIRPORT = np.array([0.55, 0.85, 1.0], dtype=np.float32)
ACCENT = (127, 214, 255)

FONT_CANDIDATES = [
    "C:/Windows/Fonts/segoeuisb.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
]


def mask(size, draw_fn):
    img = Image.new("L", size, 0)
    draw_fn(ImageDraw.Draw(img))
    return np.asarray(img, dtype=np.float32) / 255


def shifted(points, dx, s):
    return [((x + dx) * s, y * s) for x, y in points]


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    geo = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out = Path(sys.argv[2])
    font_path = sys.argv[3] if len(sys.argv) > 3 else next((f for f in FONT_CANDIDATES if Path(f).exists()), None)

    w, h = geo["width"], geo["height"]
    W, H = w * S, h * S
    world = geo["worldWidth"]
    copies = [0, -world, world]

    # Background gradient.
    t = np.linspace(0, 1, H, dtype=np.float32)[:, None, None]
    acc = np.broadcast_to(BG_TOP * (1 - t) + BG_BOTTOM * t, (H, W, 3)).copy()

    # Land fill and coastline.
    land = mask((W, H), lambda d: [d.polygon(shifted(r, dx, S), fill=255) for r in geo["land"] if len(r) > 2 for dx in copies])
    acc = acc * (1 - land[..., None] * 0.85) + LAND * land[..., None] * 0.85
    coast = mask((W, H), lambda d: [d.line(shifted(r + r[:1], dx, S), fill=255, width=S) for r in geo["land"] if len(r) > 2 for dx in copies])
    acc += COAST * coast[..., None] * 0.18

    # Routes: additive, brightness by squared weight (as in the app), top routes thicker.
    routes = sorted(geo["routes"], key=lambda r: r["flights"])
    n_notable = min(150, max(3, math.ceil(math.sqrt(len(routes)))))
    notable = routes[-n_notable:]
    glow = np.zeros((H, W, 3), dtype=np.float32)
    for r in routes:
        wgt = r["w"]
        alpha = 0.05 + 0.5 * wgt * wgt
        color = ROUTE_LOW * (1 - wgt * wgt) + ROUTE_HIGH * wgt * wgt
        m = mask((W, H), lambda d: [d.line(shifted(r["pts"], dx, S), fill=255, width=S) for dx in copies])
        glow += m[..., None] * color * alpha
    for r in notable:
        wgt = r["w"]
        m = mask((W, H), lambda d: [d.line(shifted(r["pts"], dx, S), fill=255, width=3 * S, joint="curve") for dx in copies])
        glow += m[..., None] * NOTABLE * (0.35 + 0.45 * wgt)

    # Soft bloom so dense corridors read as light rather than lines.
    bloom_src = Image.fromarray(np.clip(glow * 255, 0, 255).astype(np.uint8))
    bloom = np.asarray(bloom_src.filter(ImageFilter.GaussianBlur(6 * S)), dtype=np.float32) / 255
    acc += glow + bloom * 0.6

    # Airports.
    dots = Image.new("L", (W, H), 0)
    dd = ImageDraw.Draw(dots)
    for a in geo["airports"]:
        rad = (1.6 + 3.2 * math.sqrt(a["w"])) * S
        for dx in copies:
            x, y = (a["x"] + dx) * S, a["y"] * S
            dd.ellipse((x - rad, y - rad, x + rad, y + rad), fill=int(140 + 115 * a["w"]))
    dots_arr = np.asarray(dots.filter(ImageFilter.GaussianBlur(0.6 * S)), dtype=np.float32) / 255
    acc += dots_arr[..., None] * AIRPORT * 0.9

    # Darken towards the bottom-left so the title stays readable.
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    vignette = np.clip(1 - ((xx / W) * 1.6 + (1 - yy / H) * 1.4) / 1.2, 0, 1) ** 1.5
    acc *= (1 - 0.55 * vignette)[..., None]

    img = Image.fromarray((np.clip(acc, 0, 1) * 255).astype(np.uint8)).resize((w, h), Image.LANCZOS)

    # Title.
    draw = ImageDraw.Draw(img)
    big = ImageFont.truetype(font_path, 76) if font_path else ImageFont.load_default()
    small = ImageFont.truetype(font_path, 20) if font_path else ImageFont.load_default()
    x0, y0 = 64, h - 150
    draw.text((x0, y0), "1090", font=big, fill=(232, 240, 248))
    draw.text((x0 + draw.textlength("1090", font=big), y0), "web", font=big, fill=ACCENT)
    if geo.get("kind") == "demo":
        draw.text((x0 + 4, y0 + 96), "demo data", font=small, fill=(242, 180, 90))

    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, optimize=True)
    print(f"wrote {out} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
