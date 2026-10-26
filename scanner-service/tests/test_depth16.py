"""16 bits per channel (colour only): geometry, window, PNM output, sim, API."""

import struct
import time

import pytest

from scan3115.pnm import write_pnm
from scan3115.protocol import ScanParams, build_window, compute_geometry

from .test_jobs import make_runner, wait
from .test_server import get_json, post_json, server  # noqa: F401  (fixture)


def test_color16_doubles_line_bytes_and_sets_window_depth():
    p8 = ScanParams("flatbed", "color", 150)
    p16 = ScanParams("flatbed", "color", 150, depth=16)
    assert compute_geometry(p16).line_bytes == 2 * compute_geometry(p8).line_bytes
    w = build_window(p16, compute_geometry(p16))
    assert w[0x1A] == 0x05 and w[0x1B] == 16


def test_default_depth_is_8():
    p = ScanParams("flatbed", "gray", 150)
    assert p.depth == 8 and build_window(p, compute_geometry(p))[0x1B] == 8


@pytest.mark.parametrize("p", [
    ScanParams("flatbed", "gray", 150, depth=16),     # the scanner returns garbage for 16-bit gray
    ScanParams("flatbed", "lineart", 150, depth=16),
    ScanParams("flatbed", "color", 150, depth=12),
    ScanParams("flatbed", "color", 150, depth="16"),
    ScanParams("flatbed", "color", 150, depth=True),
])
def test_validate_rejects_bad_depth(p):
    with pytest.raises(ValueError):
        p.validate()


def test_validate_accepts_color16():
    ScanParams("adf", "color", 600, depth=16).validate()


def test_write_pnm_color16_interleaves_and_writes_big_endian(tmp_path):
    # Device line: planes R, G, B of px little-endian samples each; width 2 of px 4.
    px, width = 4, 2
    r, g, b = [0x0102, 0x0304, 0, 0], [0x1112, 0x1314, 0, 0], [0x2122, 0x2324, 0, 0]
    line = struct.pack("<12H", *r, *g, *b)
    path = str(tmp_path / "p.pnm")
    assert write_pnm(path, "color", width, px, [line, line], depth=16, max_lines=2) == 2
    data = open(path, "rb").read()
    header = b"P6\n2 2\n65535\n"
    assert data.startswith(header)
    body = data[len(header):]
    assert body[:12] == struct.pack(">6H", 0x0102, 0x1112, 0x2122, 0x0304, 0x1314, 0x2324)
    assert len(body) == 2 * width * 3 * 2


def test_sim_color16_job_page(tmp_path):
    runner, _ = make_runner(tmp_path)
    job = runner.start(ScanParams("flatbed", "color", 75, area_mm=(0, 0, 10, 10), depth=16)); wait(job)
    assert job.result.reason == "complete"
    page = job.pages[0]
    assert page.depth == 16
    data = open(page.path, "rb").read()
    header = b"P6\n30 30\n65535\n"
    assert data.startswith(header) and len(data) == len(header) + 30 * 30 * 6
    assert data.endswith(struct.pack(">3H", 0x0101, 0x0202, 0x0303))


def test_api_accepts_depth16_and_reports_it(server):  # noqa: F811
    code, body = post_json(server, "/api/scans", {"source": "flatbed", "mode": "color", "dpi": 75,
                                                  "depth": 16, "area_mm": [0, 0, 10, 10]})
    assert code == 202
    for _ in range(100):
        j = get_json(server, f"/api/scans/{body['id']}")
        if j["state"] == "done":
            break
        time.sleep(0.05)
    assert j["result"]["reason"] == "complete"
    assert j["pages"][0]["depth"] == 16


def test_api_rejects_gray16(server):  # noqa: F811
    code, _ = post_json(server, "/api/scans", {"source": "flatbed", "mode": "gray", "dpi": 75, "depth": 16})
    assert code == 400


def test_page_depth_reported_per_mode(tmp_path):
    runner, _ = make_runner(tmp_path)
    for mode, depth in (("lineart", 1), ("gray", 8)):
        job = runner.start(ScanParams("flatbed", mode, 75, area_mm=(0, 0, 10, 10))); wait(job)
        assert job.pages[0].depth == depth, mode
