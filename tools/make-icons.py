#!/usr/bin/env python3
"""Regenerate the app icons. Run from the repo root: python3 tools/make-icons.py"""
import math, struct, zlib, os

BG = (11, 13, 16)
ACCENT = (61, 220, 151)
NEEDLE = (242, 245, 247)
DIM = (58, 66, 76)
SS = 4  # supersampling factor


def draw(size, glyph_scale=0.82, corner=0.22, transparent_corners=True):
    n = size * SS
    cx = n / 2
    px = [[(0, 0, 0, 0) for _ in range(n)] for _ in range(n)]

    r_outer = n * 0.5 * glyph_scale          # radius of the meter arc
    ring_w = n * 0.055 * glyph_scale
    needle_w = n * 0.045 * glyph_scale
    needle_len = r_outer - ring_w * 1.6
    hub_r = n * 0.055 * glyph_scale
    # sit the pivot below centre so arc + needle are optically centred
    cy = n / 2 + (r_outer - hub_r) / 2
    corner_r = n * corner
    span = math.radians(72)                   # arc half-width

    for y in range(n):
        for x in range(n):
            dx, dy = x + 0.5 - cx, y + 0.5 - cy

            inside = True
            if transparent_corners:
                ax, ay = abs(x + 0.5 - n / 2), abs(y + 0.5 - n / 2)
                lim = n / 2 - corner_r
                if ax > lim and ay > lim:
                    inside = math.hypot(ax - lim, ay - lim) <= corner_r
            if not inside:
                continue

            color = BG

            # meter arc (top, symmetric about vertical)
            dist = math.hypot(dx, dy)
            if abs(dist - r_outer) <= ring_w / 2:
                ang = math.atan2(dx, -dy)     # 0 = straight up
                if abs(ang) <= span:
                    color = ACCENT if abs(ang) < math.radians(14) else DIM

            # needle, pointing straight up from the hub
            if abs(dx) <= needle_w / 2 and -needle_len <= dy <= 0:
                color = NEEDLE
            if dist <= hub_r:
                color = NEEDLE

            px[y][x] = color + (255,)

    # box-downsample for anti-aliasing
    out = bytearray()
    for y in range(size):
        out.append(0)
        for x in range(size):
            r = g = b = a = 0
            for j in range(SS):
                for i in range(SS):
                    pr, pg, pb, pa = px[y * SS + j][x * SS + i]
                    r += pr * pa; g += pg * pa; b += pb * pa; a += pa
            if a:
                out += bytes((r // a, g // a, b // a, a // (SS * SS)))
            else:
                out += bytes((0, 0, 0, 0))
    return bytes(out)


def write_png(path, size, raw):
    def chunk(tag, data):
        c = tag + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    header = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + \
        chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)
    print(f'{path} ({len(png)} bytes)')


if __name__ == '__main__':
    os.makedirs('icons', exist_ok=True)
    for size in (192, 512):
        write_png(f'icons/icon-{size}.png', size, draw(size))
    # maskable: full bleed, glyph inside the 80% safe zone
    write_png('icons/icon-maskable-512.png', 512,
              draw(512, glyph_scale=0.6, corner=0, transparent_corners=False))
    # iOS wants an opaque square
    write_png('icons/apple-touch-icon.png', 180,
              draw(180, glyph_scale=0.78, corner=0, transparent_corners=False))
