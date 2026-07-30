"""Generate the application icon.

No image library is assumed to be present, so the PNG and the ICO container are
both written by hand. The mark is a rounded indigo tile with three bars — a
list being worked through — which stays legible at 16px where any lettering
would turn to mush.

  python scripts/make-icon.py

Writes build/icon.png (1024px, what macOS and Linux want) and build/icon.ico
(256px, what Windows wants). macOS refuses anything under 512.
"""

import math
import pathlib
import struct
import zlib

ACCENT = (0x4F, 0x46, 0xE5, 255)  # --accent from the design system
FOREGROUND = (255, 255, 255, 255)


def blend(dst, src, alpha):
    return tuple(round(d + (s - d) * alpha) for d, s in zip(dst[:3], src[:3])) + (
        max(dst[3], round(255 * alpha)),
    )


def render(size):
    """The icon as a pixel grid, drawn with a signed-distance rounded rect so
    the edges are antialiased at any size."""
    px = [[(0, 0, 0, 0) for _ in range(size)] for _ in range(size)]

    def rounded_rect(x0, y0, x1, y1, radius, colour):
        for y in range(max(0, int(y0) - 2), min(size, int(y1) + 3)):
            for x in range(max(0, int(x0) - 2), min(size, int(x1) + 3)):
                cx = max(x0 + radius, min(x1 - radius, x + 0.5))
                cy = max(y0 + radius, min(y1 - radius, y + 0.5))
                distance = math.hypot(x + 0.5 - cx, y + 0.5 - cy) - radius
                alpha = min(1.0, max(0.0, 0.5 - distance))
                if alpha > 0:
                    px[y][x] = blend(px[y][x], colour, alpha)

    unit = size / 256
    rounded_rect(0, 0, size, size, 56 * unit, ACCENT)

    bar_h, gap, left = 26 * unit, 22 * unit, 54 * unit
    top = (size - (3 * bar_h + 2 * gap)) / 2
    for i, width in enumerate((148, 116, 84)):
        y = top + i * (bar_h + gap)
        rounded_rect(left, y, left + width * unit, y + bar_h, bar_h / 2, FOREGROUND)

    return px


def png(pixels, size):
    raw = b''.join(
        b'\x00' + b''.join(struct.pack('4B', *p) for p in row) for row in pixels
    )

    def chunk(tag, data):
        body = tag + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body))

    return (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(raw, 9))
        + chunk(b'IEND', b'')
    )


def main():
    out = pathlib.Path(__file__).resolve().parent.parent / 'build'
    out.mkdir(exist_ok=True)

    # macOS rejects anything under 512; 1024 is what it actually wants.
    large = png(render(1024), 1024)
    (out / 'icon.png').write_bytes(large)

    # An ICO holding one 256px PNG. Width and height of 0 mean 256.
    small = png(render(256), 256)
    ico = (
        struct.pack('<HHH', 0, 1, 1)
        + struct.pack('<BBBBHHII', 0, 0, 0, 0, 1, 32, len(small), 6 + 16)
        + small
    )
    (out / 'icon.ico').write_bytes(ico)

    print(f'icon.png 1024px, {len(large)} bytes')
    print(f'icon.ico  256px, {len(ico)} bytes')


if __name__ == '__main__':
    main()
