# SPDX-License-Identifier: GPL-3.0-or-later
import cv2
import numpy as np
import pytest

import synth
from deda_svc.detect import detect, load_rgb


@pytest.fixture(scope="module")
def positive_600() -> np.ndarray:
    return synth.page(dots=synth.tdm_dots(600))


def test_positive_found(positive_600):
    det = detect(positive_600, 600)
    assert det.found is True
    assert len(det.dots) >= 0.9 * len(synth.tdm_dots(600))
    assert det.grid_score > 3


def test_negative_bluish_letter():
    det = detect(synth.page(dots=None, paper=(0.86, 0.96, 0.95), text=True), 600)
    assert det.found is False


def test_red_box_fringes_ignored():
    det = detect(synth.page(dots=None, red_boxes=True), 600)
    assert det.found is False
    near_edge = cv2.dilate(synth.red_box_mask(600).astype(np.uint8), np.ones((9, 9), np.uint8))  # 4 px around
    ys, xs = np.rint(det.dots).astype(int).T
    assert not near_edge[ys, xs].any()


def test_300_dpi():
    det = detect(synth.page(dpi=300, dots=synth.tdm_dots(300)), 300)
    assert det.found is True


def test_sixteen_bit_input(positive_600):
    bgr16 = cv2.cvtColor(positive_600, cv2.COLOR_RGB2BGR).astype(np.uint16) * 257
    ok, png = cv2.imencode(".png", bgr16, [cv2.IMWRITE_PNG_COMPRESSION, 1])
    assert ok
    rgb = load_rgb(png.tobytes())
    assert rgb.dtype == np.uint8 and rgb.shape == positive_600.shape
    assert np.array_equal(rgb, positive_600)
    assert detect(rgb, 600).found is True


def test_unreadable():
    with pytest.raises(ValueError, match="unreadable image"):
        load_rgb(b"nope")


def test_float_tiff_unreadable():
    ok, tiff = cv2.imencode(".tiff", np.zeros((8, 8, 3), np.float32))
    assert ok
    with pytest.raises(ValueError, match="unreadable image"):
        load_rgb(tiff.tobytes())


@pytest.mark.parametrize("channels", [2, 5])
def test_odd_channel_count_unreadable(monkeypatch, channels):
    monkeypatch.setattr(cv2, "imdecode", lambda *_: np.zeros((8, 8, channels), np.uint8))
    with pytest.raises(ValueError, match="unreadable image"):
        load_rgb(b"decoded by the stub")


def test_load_rgb_eight_bit_rgb_order():
    bgr = np.zeros((4, 4, 3), np.uint8)
    bgr[..., 2] = 200  # red in OpenCV's BGR order
    ok, png = cv2.imencode(".png", bgr)
    assert ok
    rgb = load_rgb(png.tobytes())
    assert rgb.dtype == np.uint8 and (rgb[..., 0] == 200).all() and (rgb[..., 1:] == 0).all()


def test_detect_rejects_float_page():
    with pytest.raises(ValueError):
        detect(np.zeros((8, 8, 3), np.float32), 600)
