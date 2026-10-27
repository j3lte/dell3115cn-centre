# SPDX-License-Identifier: GPL-3.0-or-later
import base64

import cv2
import numpy as np
import pytest

import synth
from deda_svc.report import analyse


def _png(rgb: np.ndarray) -> bytes:
    ok, png = cv2.imencode(".png", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_PNG_COMPRESSION, 1])
    assert ok
    return png.tobytes()


@pytest.fixture(scope="module")
def positive_report() -> dict:
    return analyse(_png(synth.page(dots=synth.tdm_dots(600))), 600)


@pytest.fixture(scope="module")
def negative_report() -> dict:
    return analyse(_png(synth.page(dots=None)), 600)


def test_round_trip_decode(positive_report):
    r = positive_report
    assert r["found"] is True
    assert r["decodeError"] is None
    assert "123456" in r["decode"]["serial"]
    assert r["decode"]["manufacturer"] == "Epson"
    assert r["dpi"] == 600
    assert r["dots"] > 0 and isinstance(r["gridScore"], float)
    assert all(isinstance(c, int) and 0 <= c <= 255 for c in r["paperWhite"])
    assert set(r["images"]) == {"overview", "closeRaw", "closeEnhanced", "closeYellow"}
    assert len(r["closeOrigin"]) == 2


def test_negative_report(negative_report):
    r = negative_report
    assert r["found"] is False
    assert r["decode"] is None and r["decodeError"] is None
    assert set(r["images"]) == {"overview"}


def test_images_are_png(positive_report, negative_report):
    for r in (positive_report, negative_report):
        for b64 in r["images"].values():
            assert base64.b64decode(b64).startswith(b"\x89PNG")
    overview = cv2.imdecode(np.frombuffer(base64.b64decode(positive_report["images"]["overview"]), np.uint8),
                            cv2.IMREAD_COLOR)
    assert max(overview.shape[:2]) == 1600
    close = cv2.imdecode(np.frombuffer(base64.b64decode(positive_report["images"]["closeRaw"]), np.uint8),
                         cv2.IMREAD_COLOR)
    side = 3 * round(12 * 600 / 25.4)
    assert close.shape[:2] == (side, side)


def test_closeup_avoids_ink():
    px = lambda mm: round(mm * 600 / 25.4)  # noqa: E731
    img = synth.page(dots=synth.tdm_dots(600), text=False)
    for top in range(5, 297, 5):  # 0.5 mm black lines every 5 mm, over the whole page
        img[px(top):px(top + 0.5)] = 13
    clear_y, clear_x = px(150), px(100)
    clear = synth.page(dots=synth.tdm_dots(600), text=False)[clear_y:clear_y + px(20), clear_x:clear_x + px(20)]
    img[clear_y:clear_y + px(20), clear_x:clear_x + px(20)] = clear

    r = analyse(_png(img), 600)
    assert r["found"] is True
    y, x = r["closeOrigin"]
    side = px(12)
    assert clear_y <= y and y + side <= clear_y + px(20)
    assert clear_x <= x and x + side <= clear_x + px(20)


def test_decode_failure_is_reported():
    from deda_svc.decode import decode
    result, error = decode(np.array([[100, 100], [140, 120]], np.float32), synth.page_shape(600), 600)
    assert result is None
    assert isinstance(error, str) and error
