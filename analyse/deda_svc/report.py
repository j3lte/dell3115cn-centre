# SPDX-License-Identifier: GPL-3.0-or-later
"""The JSON-ready analysis report of one scanned page."""

import base64

from .decode import decode
from .detect import detect, load_rgb
from .render import close_origin, closeups_png, overview_png


def _b64(png: bytes) -> str:
    return base64.b64encode(png).decode("ascii")


def analyse(data: bytes, dpi: int) -> dict:
    rgb = load_rgb(data)
    det = detect(rgb, dpi)
    images = {}
    origin = close_origin(rgb, det.dots, dpi)
    if origin is not None:
        raw, enhanced, yellow = closeups_png(rgb, det, dpi, origin)
        images.update(closeRaw=_b64(raw), closeEnhanced=_b64(enhanced), closeYellow=_b64(yellow))
    det.yellow = None  # the largest buffer: free it before the overview
    images = {"overview": _b64(overview_png(rgb, det.dots)), **images}
    shape_hw = rgb.shape[:2]
    del rgb
    result, error = decode(det.dots, shape_hw, dpi) if det.found else (None, None)
    return {
        "found": det.found,
        "dots": len(det.dots),
        "gridScore": round(det.grid_score, 2),
        "dpi": dpi,
        "paperWhite": [round(c * 255) for c in det.paper_white],
        "decode": result,
        "decodeError": error,
        "closeOrigin": list(origin) if origin is not None else None,
        "images": images,
    }
