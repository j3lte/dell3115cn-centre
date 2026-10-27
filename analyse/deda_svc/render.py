# SPDX-License-Identifier: GPL-3.0-or-later
"""Preview images: the whole page with the found dots, and close-ups of the densest dot area."""

import cv2
import numpy as np

from .detect import INK_MIN, Detection

OVERVIEW_SIDE = 1600  # px, long side
DOT_COLOUR = (20, 80, 230)  # RGB
DOT_RADIUS = 1.5  # px in the overview
CLOSE_MM = 12
CLOSE_SCALE = 3
CELLS = 4  # close-up candidates are searched on a grid of CLOSE_MM / CELLS
BAND = 256  # rows per band for per-pixel work
SHIFT = 2  # sub-pixel bits for cv2.circle


def _png(img: np.ndarray) -> bytes:
    """PNG bytes of a grey (H x W) or RGB (H x W x 3) uint8 image."""
    if img.ndim == 3:
        img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    ok, png = cv2.imencode(".png", img)
    if not ok:
        raise RuntimeError("PNG encoding failed")
    return png.tobytes()


def overview_png(rgb: np.ndarray, dots: np.ndarray) -> bytes:
    """The page in grey washed out to 200..255, long side OVERVIEW_SIDE px, dots as blue discs."""
    h, w = rgb.shape[:2]
    f = OVERVIEW_SIDE / max(h, w)
    small = cv2.resize(rgb, (round(w * f), round(h * f)), interpolation=cv2.INTER_AREA)
    grey = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY)
    grey = (200 + grey.astype(np.uint16) * 55 // 255).astype(np.uint8)
    out = cv2.cvtColor(grey, cv2.COLOR_GRAY2RGB)
    one = 1 << SHIFT
    for y, x in np.rint(dots * f * one).astype(int):
        cv2.circle(out, (int(x), int(y)), round(DOT_RADIUS * one), DOT_COLOUR, -1, cv2.LINE_8, SHIFT)
    return _png(out)


def _ink_cells(rgb: np.ndarray, cell: int) -> np.ndarray:
    """Per cell of cell x cell px: whether it holds an ink pixel (bool rows x cols, full cells only)."""
    h, w = rgb.shape[:2]
    rows, cols = h // cell, w // cell
    ink = np.zeros((rows, cols), bool)
    limit = INK_MIN * 255
    step = max(1, BAND // cell) * cell
    for y0 in range(0, rows * cell, step):
        band = rgb[y0:min(y0 + step, rows * cell), :cols * cell].min(axis=2) <= limit
        ink[y0 // cell:y0 // cell + band.shape[0] // cell] = (
            band.reshape(-1, cell, cols, cell).any(axis=(1, 3)))
    return ink


def _window_sums(a: np.ndarray, k: int) -> np.ndarray:
    """Sums of every k x k window of a 2-D array (rows - k + 1 x cols - k + 1)."""
    c = np.pad(a.astype(np.int64), ((1, 0), (1, 0))).cumsum(0).cumsum(1)
    return c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]


def close_origin(rgb: np.ndarray, dots: np.ndarray, dpi: int) -> tuple[int, int] | None:
    """Top-left (y, x) px of the CLOSE_MM square with the most dots and no ink; any ink if none is clear."""
    if len(dots) == 0:
        return None
    cell = max(1, round(CLOSE_MM * dpi / 25.4 / CELLS))
    ink = _ink_cells(rgb, cell)
    if min(ink.shape) < CELLS:
        return None
    count = np.zeros(ink.shape, np.int64)
    cy, cx = (dots // cell).astype(int).T
    ok = (cy < ink.shape[0]) & (cx < ink.shape[1])
    np.add.at(count, (cy[ok], cx[ok]), 1)
    dense = _window_sums(count, CELLS)
    clear = _window_sums(ink, CELLS) == 0
    score = np.where(clear & (dense > 0), dense, -1)
    if score.max() < 0:
        score = dense
    y, x = np.unravel_index(int(np.argmax(score)), score.shape)
    return int(y) * cell, int(x) * cell


def _stretch(a: np.ndarray) -> np.ndarray:
    lo, hi = float(a.min()), float(a.max())
    out = (a.astype(np.float32) - lo) * (255 / max(hi - lo, 1e-6))
    return np.clip(out, 0, 255).astype(np.uint8)


def closeups_png(rgb: np.ndarray, det: Detection, dpi: int,
                 origin: tuple[int, int] | None = None) -> tuple[bytes, bytes, bytes] | None:
    """Raw, blue-channel-stretched and yellowness close-ups of the densest clear dot area, scaled up nearest."""
    if origin is None:
        origin = close_origin(rgb, det.dots, dpi)
    if origin is None:
        return None
    y, x = origin
    side = round(CLOSE_MM * dpi / 25.4)
    raw = rgb[y:y + side, x:x + side]
    up = lambda img: cv2.resize(img, None, fx=CLOSE_SCALE, fy=CLOSE_SCALE,  # noqa: E731
                                interpolation=cv2.INTER_NEAREST)
    return (_png(up(raw)), _png(up(_stretch(raw[..., 2]))),
            _png(up(_stretch(det.yellow[y:y + side, x:x + side]))))
