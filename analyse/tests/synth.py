# SPDX-License-Identifier: GPL-3.0-or-later
"""Generated test pages: A4 paper, black "text", red boxes and pale yellow tracking dots.

Never real scans. The tracking dots encode a fake serial (123456) with DEDA's Pattern4.
"""

import cv2
import numpy as np
from libdeda.pattern_handler import TDM, Pattern4

A4_MM = (297.0, 210.0)  # height, width
DOT_RADIUS_MM = 0.05
DOT_TINT = (1.0, 1.0, 0.82)  # dots drop blue by ~18 %
NOISE_SIGMA = 0.012
RED_INK = (0.80, 0.12, 0.25)
# Red as a real scan of this printer's test page shows it: solid, blue a little below green, so "blue is the lowest
# channel" alone does not tell it from yellow.
RED_INK_SCANNED = (0.62, 0.25, 0.22)
RED_LINE_MM = 2.0
# Outer edges of each red box: top, left, bottom, right, in mm.
RED_BOXES_MM = [(160, 20, 200, 100), (160, 110, 200, 190), (210, 20, 280, 190)]


def _px(mm: float, dpi: int) -> int:
    return round(mm * dpi / 25.4)


def page_shape(dpi: int) -> tuple[int, int]:
    return _px(A4_MM[0], dpi), _px(A4_MM[1], dpi)


def tdm_dots(dpi: int, serial: int = 123456) -> np.ndarray:
    """Dot centres (N x 2 float32, y, x in px) of a Pattern4 matrix tiled over an A4 page."""
    tdm = TDM(Pattern4, content=dict(serial=serial, year=18, month=11, day=11, hour=11, minutes=11,
                                     manufacturer="Epson"))
    ii, jj = np.nonzero(tdm.undoTransformation())  # i runs across the page, j down
    h, w = page_shape(dpi)
    margin = 0.1  # inch
    ox = margin + tdm.hps * np.arange(int(w / dpi / tdm.hps) + 1)
    oy = margin + tdm.vps * np.arange(int(h / dpi / tdm.vps) + 1)
    cy, cx = (a.ravel() for a in np.meshgrid(oy, ox, indexing="ij"))  # top-left corner of each matrix
    ys = cy[:, None] + jj[None, :] * tdm.d_j
    xs = cx[:, None] + ii[None, :] * tdm.d_i
    dots = (np.stack([ys.ravel(), xs.ravel()], axis=1) * dpi).astype(np.float32)
    inside = (dots[:, 0] < h - 2) & (dots[:, 1] < w - 2)
    return dots[inside]


def red_box_mask(dpi: int) -> np.ndarray:
    """Where the red box lines are (bool H x W), before blur and misregistration."""
    mask = np.zeros(page_shape(dpi), bool)
    lw = _px(RED_LINE_MM, dpi)
    for top, left, bottom, right in RED_BOXES_MM:
        t, l, b, r = (_px(v, dpi) for v in (top, left, bottom, right))
        mask[t:b, l:r] = True
        mask[t + lw:b - lw, l + lw:r - lw] = False
    return mask


def page(dpi: int = 600, dots: np.ndarray | None = None, paper=(0.86, 0.96, 0.95), text: bool = True,
         red_boxes: bool = False, red_scanned: bool = False, seed: int = 0) -> np.ndarray:
    """A generated scan of an A4 page (uint8 H x W x 3, RGB)."""
    rng = np.random.default_rng(seed)
    h, w = page_shape(dpi)
    paper = np.asarray(paper, np.float32)
    img = np.empty((h, w, 3), np.float32)
    img[:] = paper

    if dots is not None:
        radius = max(1, _px(DOT_RADIUS_MM, dpi))
        colour = tuple(float(c) for c in paper * np.asarray(DOT_TINT, np.float32))
        for y, x in np.rint(dots).astype(int):
            cv2.circle(img, (int(x), int(y)), radius, colour, -1)

    if text:  # a block of "words": black rectangles 2 mm high, one line every 8 mm
        lh = _px(2, dpi)
        for top in range(40, 140, 8):
            x = 20.0
            while True:
                width = rng.uniform(3, 15)
                if x + width > 190:
                    break
                img[_px(top, dpi):_px(top, dpi) + lh, _px(x, dpi):_px(x + width, dpi)] = 0.05
                x += width + 2

    if red_boxes:
        # Red is printed as solid magenta (drops green) plus a halftoned yellow layer (drops blue). The yellow layer
        # is shifted by 2 px (misregistration), so its halftone dots stick out as a yellow fringe on one side of
        # every line. Everything is blurred by 1 px. red_scanned: the red as a real scan shows it (RED_INK_SCANNED),
        # blue drops under the whole line, not only under the halftone.
        sharp = red_box_mask(dpi)
        shift = max(1, round(2 * dpi / 600))
        cell = max(2, round(4 * dpi / 600))  # halftone period
        yy, xx = np.ogrid[:h, :w]
        screen = (yy % cell < cell // 2) & (xx % cell < cell // 2)
        yellow = np.zeros_like(sharp)
        yellow[shift:, shift:] = sharp[:-shift, :-shift]
        yellow &= screen
        magenta = cv2.GaussianBlur(sharp.astype(np.float32), (0, 0), 1)
        yellow = cv2.GaussianBlur(yellow.astype(np.float32), (0, 0), 1)
        red_ink = RED_INK_SCANNED if red_scanned else RED_INK
        blue = np.maximum(magenta, yellow) if red_scanned else yellow
        for c, m in enumerate((magenta, magenta, blue)):
            img[..., c] += m * (red_ink[c] - paper[c])
        del sharp, screen, magenta, yellow, blue

    for y0 in range(0, h, 1024):  # noise in bands, to keep memory down
        band = img[y0:y0 + 1024]
        band += rng.standard_normal(band.shape, dtype=np.float32) * NOISE_SIGMA
    np.clip(img, 0, 1, out=img)
    img *= 255
    return np.rint(img).astype(np.uint8)
