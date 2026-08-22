#!/usr/bin/env python3
"""Generate PWA icons: Greek capital Pi (Π) glyph on a solid background.

Pure stdlib (zlib + struct) — emits truecolor PNGs at the requested sizes.
Run from repo root:  python3 scripts/gen-icons.py
Outputs public/icons/icon-{192,512}.png (and maskable variants).
"""
import struct
import zlib
from pathlib import Path

BG = (36, 86, 166)      # --accent #2456a6
FG = (253, 252, 250)    # page background white-ish

def chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(
        ">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

def png(width: int, height: int, px) -> bytes:
    raw = b"".join(b"\x00" + bytes(v for x in range(width) for v in px(x, y))
                   for y in range(height))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))

def pi_pixels(size: int):
    """Π as three filled bars: top bar + two legs, centred with margins."""
    m = round(size * 0.18)            # outer margin
    bar = max(2, round(size * 0.10))  # stroke thickness
    top_y = round(size * 0.26)
    top_h = bar
    leg_h = size - top_y - round(size * 0.22)
    lx = m
    rx = size - m - bar
    leg_w = bar
    def px(x: int, y: int):
        if y >= top_y and y < top_y + top_h:
            return (*FG,) if m <= x < size - m else (*BG,)
        if y < top_y + top_h + leg_h and (lx <= x < lx + leg_w or rx <= x < rx + leg_w):
            return (*FG,)
        return (*BG,)
    return px

out = Path("public/icons")
out.mkdir(parents=True, exist_ok=True)
for s in (192, 512):
    (out / f"icon-{s}.png").write_bytes(png(s, s, pi_pixels(s)))
print("wrote", sorted(p.name for p in out.iterdir()))
