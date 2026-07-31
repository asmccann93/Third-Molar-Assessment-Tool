from PIL import Image, ImageDraw

NAVY   = (15, 47, 99, 255)      # --navy  #0F2F63
ACCENT = (30, 77, 155, 255)     # --accent #1E4D9B
WHITE  = (255, 255, 255, 255)
SS = 4  # supersample factor

def draw_icon(size, inset=0.06):
    """Cartridge glyph: navy rounded square on white, white barrel, accent plunger."""
    S = size * SS
    im = Image.new("RGBA", (S, S), WHITE)
    d = ImageDraw.Draw(im)

    # navy rounded square
    m = inset * S
    d.rounded_rectangle([m, m, S - m, S - m], radius=0.22 * S, fill=NAVY)

    cx = S / 2
    bw = 0.24 * S                     # barrel width
    btop, bbot = 0.30 * S, 0.72 * S   # barrel extent

    # barrel
    d.rounded_rectangle([cx - bw/2, btop, cx + bw/2, bbot], radius=0.05 * S, fill=WHITE)

    # plunger stem + cap above the barrel
    sw = 0.07 * S
    d.rectangle([cx - sw/2, 0.20 * S, cx + sw/2, btop], fill=WHITE)
    cw = 0.19 * S
    d.rounded_rectangle([cx - cw/2, 0.155 * S, cx + cw/2, 0.215 * S],
                        radius=0.018 * S, fill=WHITE)

    # accent bung inside the barrel — reads as liquid level, and gives the glyph
    # a second tone so it isn't a flat white slab at small sizes
    d.rounded_rectangle([cx - bw/2 + 0.022*S, btop + 0.045*S,
                         cx + bw/2 - 0.022*S, btop + 0.105*S],
                        radius=0.012 * S, fill=ACCENT)

    # hub + needle below
    hw = 0.11 * S
    d.rounded_rectangle([cx - hw/2, bbot, cx + hw/2, bbot + 0.055 * S],
                        radius=0.012 * S, fill=WHITE)
    nw = 0.035 * S
    d.rectangle([cx - nw/2, bbot + 0.055 * S, cx + nw/2, 0.845 * S], fill=WHITE)

    return im.resize((size, size), Image.LANCZOS)

import os
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")

for name, size, inset in [
    ("icon-512.png", 512, 0.06),
    ("icon-192.png", 192, 0.06),
    ("apple-touch-icon.png", 180, 0.06),
    ("favicon-32.png", 32, 0.04),
    # maskable: platforms crop to a circle inscribed in the centre 80%, so the
    # navy plate is pulled in further to keep the glyph inside the safe zone
    ("icon-maskable-512.png", 512, 0.14),
]:
    draw_icon(size, inset).save(os.path.join(ROOT, name))
    print("wrote", name)
