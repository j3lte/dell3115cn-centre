"""Write device lines as binary PNM (P4 line art, P5 gray, P6 colour)."""

import os
import sys
from array import array
from typing import Iterable

from .protocol import SpoolError

MAGIC = {"lineart": "P4", "gray": "P5", "color": "P6"}


def _interleave16(raw: bytes, width: int, px: int) -> bytes:
    """Planar little-endian R, G, B samples -> interleaved big-endian RGB (PNM's 16-bit order)."""
    planes = array("H")
    planes.frombytes(raw[: 6 * px])
    if sys.byteorder == "big":
        planes.byteswap()
    out = array("H", bytes(6 * width))
    out[0::3] = planes[0:width]
    out[1::3] = planes[px:px + width]
    out[2::3] = planes[2 * px:2 * px + width]
    if sys.byteorder == "little":
        out.byteswap()
    return out.tobytes()


def _header(mode: str, width: int, height: int, depth: int, digits: int) -> bytes:
    # The height is right-aligned in a fixed-width field so the header can be rewritten in place once the
    # line count is known. Extra blanks between width and height are plain PNM whitespace.
    return (f"{MAGIC[mode]}\n{width} {height:>{digits}}\n"
            + ("" if mode == "lineart" else f"{(1 << depth) - 1}\n")).encode()


def write_pnm(path: str, mode: str, width: int, px: int, rows: Iterable[bytes], depth: int = 8,
              max_lines: int | None = None) -> int:
    """Write rows cropped to `width` pixels; returns the number of lines written.

    Line art arrives MSB-first with 1 = black, which is PBM's own convention.
    Colour arrives line-planar (R, G, B planes of `px` pixels) and is interleaved here; 16-bit colour
    samples arrive little-endian and are written big-endian with maxval 65535, as PNM requires.
    The line count is only known at the end: the header goes first with room for up to `max_lines`
    lines (default: 10 digits) and is rewritten in place when the page is done, so every byte is written
    once. The page is written to a temp file next to `path` and renamed into place when complete.
    PNM allows exactly one whitespace byte between header and data. On any error the partial file is
    removed and the error is re-raised.
    """
    digits = len(str(max_lines)) if max_lines is not None else 10
    tmp = path + ".part"
    count = 0
    try:
        try:
            out = open(tmp, "wb")
        except OSError as e:
            raise SpoolError(f"spool write failed: {e}") from e
        with out:
            try:
                out.write(_header(mode, width, 0, depth, digits))
            except OSError as e:
                raise SpoolError(f"spool write failed: {e}") from e
            for raw in rows:  # scanner errors from `rows` propagate unchanged
                if mode == "lineart":
                    chunk = raw[: (width + 7) // 8]
                elif mode == "gray":
                    chunk = raw[:width]
                elif depth == 16:
                    chunk = _interleave16(raw, width, px)
                else:
                    buf = bytearray(width * 3)
                    buf[0::3] = raw[:width]
                    buf[1::3] = raw[px:px + width]
                    buf[2::3] = raw[2 * px:2 * px + width]
                    chunk = buf
                try:
                    out.write(chunk)
                except OSError as e:
                    raise SpoolError(f"spool write failed: {e}") from e
                count += 1
            if len(str(count)) > digits:
                raise SpoolError(f"page has {count} lines, more than the {max_lines} expected")
            try:
                out.seek(0)
                out.write(_header(mode, width, count, depth, digits))
            except OSError as e:
                raise SpoolError(f"spool write failed: {e}") from e
        try:
            os.replace(tmp, path)
        except OSError as e:
            raise SpoolError(f"spool write failed: {e}") from e
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise
    return count
