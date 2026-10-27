# SPDX-License-Identifier: GPL-3.0-or-later
"""Find yellow printer tracking dots in a scanned page.

All sizes are tuned for 600 dpi and scaled by dpi / 600. Levels are in 0..1. The page stays uint8 (a 600 dpi A4 page
is 104 MB); float32 is only used per band of rows and for the yellowness map.
"""

from dataclasses import dataclass

import cv2
import numpy as np

PAPER_MIN = 0.70  # pixels brighter than this in every channel are paper
INK_MIN = 0.47  # pixels with a channel at or below this are ink: never dots
COLOUR_SPREAD = 0.25  # max - min above this: coloured ink, unless yellowish
COLOUR_DILATE = 4  # px at 600 dpi around coloured ink where dots are ignored
THRESHOLD_FACTOR = 0.7  # of the 99.9th percentile of the yellowness map
THRESHOLD_MIN = 0.04
DOT_AREA = (2, 40)  # px at 600 dpi
PERIOD = 24  # px at 600 dpi: the 0.04 in dot grid
TILE_PERIODS = 20  # tile side for the grid score, in periods (480 px at 600 dpi)
GRID_SCORE_MIN = 3.0
DOTS_MIN = 50
BAND = 256  # rows per band for per-pixel work


@dataclass
class Detection:
    dots: np.ndarray  # N x 2 float32, (y, x) in px
    grid_score: float
    found: bool
    paper_white: tuple[float, float, float]
    yellow: np.ndarray  # H x W float32 yellowness map


def load_rgb(data: bytes) -> np.ndarray:
    """Decode PNG (8 or 16 bit), PNM, TIFF or JPEG to H x W x 3 uint8 RGB."""
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
    if (img is None or img.dtype not in (np.uint8, np.uint16)
            or not (img.ndim == 2 or (img.ndim == 3 and img.shape[2] in (3, 4)))):
        raise ValueError("unreadable image")
    if img.dtype == np.uint16:  # 16 bit to 8 bit, shifting in place: one extra 8-bit buffer only
        np.right_shift(img, 8, out=img)
        img = img.astype(np.uint8)
    if img.ndim == 2:
        return cv2.cvtColor(img, cv2.COLOR_GRAY2RGB)
    if img.shape[2] == 4:
        return cv2.cvtColor(img, cv2.COLOR_BGRA2RGB)
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB, dst=img)


def _paper_white(rgb: np.ndarray) -> np.ndarray:
    sample = rgb[::4, ::4].reshape(-1, 3) / np.float32(255)  # a subsample is plenty for a median
    paper = sample[sample.min(axis=1) > PAPER_MIN]
    if len(paper) == 0:
        return np.ones(3, np.float32)
    return np.median(paper, axis=0).astype(np.float32)


def _percentile(a: np.ndarray, q: float) -> float:
    """Percentile of a map in 0..1 from a histogram, without copying the map."""
    hist, edges = np.histogram(a, bins=4096, range=(0, 1))
    i = np.searchsorted(np.cumsum(hist), q / 100 * a.size)
    return float(edges[min(i + 1, len(edges) - 1)])


def _grid_score(yellow: np.ndarray, dots: np.ndarray, period: int) -> float:
    """Median, over tiles with dots, of peak / median of the yellowness folded modulo the dot period."""
    tile = TILE_PERIODS * period
    h, w = yellow.shape
    has_dots = np.zeros((h // tile, w // tile), bool)
    ty, tx = (dots // tile).astype(int).T
    ok = (ty < has_dots.shape[0]) & (tx < has_dots.shape[1])
    has_dots[ty[ok], tx[ok]] = True
    scores = []
    for y, x in zip(*np.nonzero(has_dots)):
        t = yellow[y * tile:(y + 1) * tile, x * tile:(x + 1) * tile]
        fold = t.reshape(TILE_PERIODS, period, TILE_PERIODS, period).sum(axis=(0, 2))
        scores.append(fold.max() / max(float(np.median(fold)), 1e-6))
    return float(np.median(scores)) if scores else 0.0


def detect(rgb: np.ndarray, dpi: int) -> Detection:
    """Find the dots in an H x W x 3 uint8 RGB page (from load_rgb)."""
    if rgb.dtype != np.uint8 or rgb.ndim != 3 or rgb.shape[2] != 3:
        raise ValueError("expected an H x W x 3 uint8 RGB page")
    s = dpi / 600
    h, w = rgb.shape[:2]
    white = _paper_white(rgb)

    yellow = np.empty((h, w), np.float32)
    colour = np.empty((h, w), np.uint8)
    for y0 in range(0, h, BAND):
        band = rgb[y0:y0 + BAND] / np.float32(255)
        ink = band.min(axis=2) <= INK_MIN
        n = band / white
        rg = np.minimum(n[..., 0], n[..., 1])
        b = n[..., 2]
        spread = n.max(axis=2) - n.min(axis=2)
        colour[y0:y0 + BAND] = (spread > COLOUR_SPREAD) & ~(b < rg)
        yb = np.clip(rg - b, 0, 1)
        yb[ink] = 0
        yellow[y0:y0 + BAND] = yb

    r = round(COLOUR_DILATE * s)
    if r > 0:
        cv2.dilate(colour, np.ones((2 * r + 1, 2 * r + 1), np.uint8), dst=colour)
    yellow[colour.view(bool)] = 0
    del colour
    cv2.blur(yellow, (3, 3), dst=yellow)

    threshold = max(THRESHOLD_FACTOR * _percentile(yellow, 99.9), THRESHOLD_MIN)
    stats, centroids = cv2.connectedComponentsWithStats(  # drop the full-page label map at once
        (yellow > threshold).view(np.uint8), connectivity=8, ltype=cv2.CV_32S)[2:]
    area = stats[1:, cv2.CC_STAT_AREA]
    keep = (area >= DOT_AREA[0] * s * s) & (area <= DOT_AREA[1] * s * s)
    dots = centroids[1:][keep][:, ::-1].astype(np.float32)  # (x, y) -> (y, x)

    grid_score = _grid_score(yellow, dots, round(PERIOD * s))
    return Detection(
        dots=dots,
        grid_score=grid_score,
        found=grid_score > GRID_SCORE_MIN and len(dots) >= DOTS_MIN,
        paper_white=tuple(float(c) for c in white),
        yellow=yellow,
    )
