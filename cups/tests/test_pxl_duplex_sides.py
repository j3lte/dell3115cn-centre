"""Tests for pxl-duplex-sides.py (fixes DuplexPageSide in Ghostscript PCL XL output).

Run: uv run --with pytest pytest cups/tests
"""

import importlib.util
import io
import re
import subprocess
import sys
from pathlib import Path

CUPS = Path(__file__).resolve().parent.parent
HELPER = CUPS / "filter" / "pxl-duplex-sides.py"

spec = importlib.util.spec_from_file_location("pxl_duplex_sides", HELPER)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def page_header(mode: int, side: int) -> bytes:
    # ... Orientation, MediaSize, MediaSource, DuplexPageMode, DuplexPageSide, BeginPage
    return bytes.fromhex("c000f828 c002f825 c001f826") + bytes([0xC0, mode, 0xF8, 0x35, 0xC0, side, 0xF8, 0x36, 0x43])


def job(pages: int, mode: int = 1, filler: bytes = b"\x00" * 50) -> bytes:
    return b"\x1b%-12345X@PJL ENTER LANGUAGE = PCLXL\n" + b"".join(
        page_header(mode, 0) + filler for _ in range(pages)
    )


def sides(data: bytes) -> list[int]:
    return [m.group(1)[0] for m in re.finditer(rb"\xc0([\x00\x01])\xf8\x36\x43", data)]


def run(data: bytes, chunk: int) -> bytes:
    out = io.BytesIO()
    mod.fix_sides(io.BytesIO(data), out, chunk=chunk)
    return out.getvalue()


def test_alternates_front_back():
    assert sides(run(job(4), 65536)) == [0, 1, 0, 1]


def test_short_edge_mode_kept():
    out = run(job(3, mode=0), 65536)
    assert sides(out) == [0, 1, 0]
    assert out.count(bytes([0xC0, 0, 0xF8, 0x35])) == 3


def test_headers_split_across_chunks():
    data = job(5, filler=b"\x11" * 7)
    for chunk in range(1, 20):
        assert sides(run(data, chunk)) == [0, 1, 0, 1, 0], chunk


def test_only_side_bytes_change():
    data = job(4)
    out = run(data, 3)
    assert len(out) == len(data)
    diff = [i for i, (a, b) in enumerate(zip(data, out)) if a != b]
    assert len(diff) == 2


def test_simplex_stream_unchanged():
    data = b"\x1b%-12345X" + bytes.fromhex("c000f834 43") * 3
    assert run(data, 4) == data


def test_cli_stdin_stdout():
    res = subprocess.run([sys.executable, str(HELPER)], input=job(2), capture_output=True)
    assert res.returncode == 0
    assert sides(res.stdout) == [0, 1]
