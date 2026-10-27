# SPDX-License-Identifier: GPL-3.0-or-later
"""Decode the dot matrix with DEDA from a clean redraw of the found dots."""

import warnings

import cv2
import numpy as np
from libdeda.print_parser import PrintParser

DECODE_DPI = 300
DOT_RADIUS = 1  # px at DECODE_DPI
YELLOW_BGR = (0, 255, 255)


def redraw_png(dots: np.ndarray, shape_hw: tuple[int, int], dpi: int) -> bytes:
    """The dot centres as pure yellow discs on white at DECODE_DPI, as PNG bytes."""
    f = DECODE_DPI / dpi
    canvas = np.full((round(shape_hw[0] * f), round(shape_hw[1] * f), 3), 255, np.uint8)
    for y, x in np.rint(dots * f).astype(int):
        cv2.circle(canvas, (int(x), int(y)), DOT_RADIUS, YELLOW_BGR, -1)
    ok, png = cv2.imencode(".png", canvas)
    if not ok:
        raise RuntimeError("PNG encoding failed")
    return png.tobytes()


def decode(dots: np.ndarray, shape_hw: tuple[int, int], dpi: int) -> tuple[dict | None, str | None]:
    """(decoded fields as strings, None) or (None, the error)."""
    try:
        with warnings.catch_warnings():  # DEDA averages empty slices while it tries pattern candidates
            warnings.simplefilter("ignore", RuntimeWarning)
            # Our own ydxArgs dict: DEDA stores the image in its mutable default otherwise.
            pp = PrintParser(redraw_png(dots, shape_hw, dpi), ydxArgs={"inputDpi": DECODE_DPI})
        fields = {"pattern": pp.pattern, **pp.tdm.decode()}
    except Exception as e:  # DEDA raises many kinds of errors on matrices it cannot read
        return None, str(e) or type(e).__name__
    return {k: str(v) for k, v in fields.items()}, None
