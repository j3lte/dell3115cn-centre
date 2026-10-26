#!/usr/bin/env python3
"""Fix DuplexPageSide in Ghostscript's PCL XL output: front side on odd pages, back side on even pages.

Ghostscript 10.0's PDF interpreter calls setpagedevice on every page, and the pxl driver starts a new sheet
whenever it receives the Duplex parameter, so every page is marked front side and a two-sided job prints
one-sided (10.08 is fixed). Rewriting the side byte is independent of the Ghostscript version.

The page header ends with the ubyte attributes DuplexPageMode (0x35) and DuplexPageSide (0x36) followed by
the BeginPage operator (0x43): c0 <mode> f8 35 c0 <side> f8 36 43. Only <side> is changed.
Reads PCL XL on stdin, writes it to stdout.
"""

import re
import sys

HEADER = re.compile(rb"\xc0[\x00\x01]\xf8\x35\xc0[\x00\x01]\xf8\x36\x43")
SIDE_OFFSET = 5
KEEP = 8  # a header split across reads starts within the last len(header) - 1 bytes


def fix_sides(src, dst, chunk: int = 1 << 16) -> None:
    page = 0
    buf = bytearray()
    while True:
        data = src.read(chunk)
        buf += data
        # A header that starts before the cut-off has been rewritten already and is not seen again,
        # because its first byte is written out below.
        for m in HEADER.finditer(buf):
            page += 1
            buf[m.start() + SIDE_OFFSET] = 0 if page % 2 else 1
        if not data:
            dst.write(buf)
            return
        cut = max(0, len(buf) - KEEP)
        dst.write(buf[:cut])
        del buf[:cut]


if __name__ == "__main__":
    fix_sides(sys.stdin.buffer, sys.stdout.buffer)
    sys.stdout.buffer.flush()
