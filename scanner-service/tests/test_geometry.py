import pytest

from scan3115.protocol import (FeederEmpty, ScanParams, Scanner, build_window, compute_geometry,
                               scan_page)


def test_geometry_2in_square_gray_150():
    g = compute_geometry(ScanParams("flatbed", "gray", 150, area_mm=(0, 0, 50.8, 50.8)))
    assert (g.x600, g.y600, g.w600, g.h600) == (0, 0, 1216, 1200)
    assert (g.width, g.lines, g.px, g.line_bytes) == (300, 300, 320, 320)


def test_window_bytes_match_hardware_capture():
    p = ScanParams("flatbed", "gray", 150, area_mm=(0, 0, 50.8, 50.8))
    assert build_window(p, compute_geometry(p)) == bytes.fromhex(
        "0000009600960000" "0000000000000000" "000004c0000004b0"
        "0000020800320000" "0000000000000000" "000004c0000004b0")


def test_full_glass_color_150_clamps_width_to_5100():
    g = compute_geometry(ScanParams("flatbed", "color", 150))
    assert (g.w600, g.h600, g.width, g.lines, g.px, g.line_bytes) == (5100, 7008, 1273, 1752, 1280, 3840)


def test_lineart_line_bytes_and_threshold():
    p = ScanParams("flatbed", "lineart", 150)
    g = compute_geometry(p)
    w = build_window(p, g)
    assert g.line_bytes == 160 and w[0x19] == 0xC3 and w[0x1a] == 0x00 and w[0x1b] == 1


def test_adf_window_flag_and_composition_color():
    p = ScanParams("adf", "color", 300)
    w = build_window(p, compute_geometry(p))
    assert w[0x1d] == 0x36 and w[0x1a] == 0x05 and w[0x1b] == 8


def test_validate_rejects_bad_params():
    for bad in [ScanParams("flatbed", "gray", 123),
                ScanParams("flatbed", "gray", 150, area_mm=(-1, 0, 10, 10)),
                ScanParams("flatbed", "gray", 150, area_mm=(0, 0, 300, 10)),
                ScanParams("flatbed", "sepia", 150)]:
        with pytest.raises(ValueError):
            bad.validate()
    ScanParams("adf", "color", 300, paper="legal").validate()


OK = "000b00000000"  # status byte 2 = good, flags 0x0b, no data


def _ok(cmd):
    return bytes.fromhex(f"00{cmd:02x}{OK}")


TINY = ScanParams("flatbed", "gray", 75, area_mm=(0, 0, 10.16, 0.68))  # 30 x 2 px → 32-byte lines


def test_scan_page_command_order_and_release(scripted):
    g = compute_geometry(TINY)
    assert (g.lines, g.line_bytes) == (2, 32)
    data = bytes(range(64))
    t = scripted([_ok(0x40), _ok(0x42), _ok(0x4c), _ok(0x44), _ok(0x44), _ok(0x45), _ok(0x48),
                  bytes.fromhex("0049000e00000040") + data, _ok(0x4c), _ok(0x4a)])
    lines = list(scan_page(Scanner(t), TINY, 0x40000))
    assert lines == [data[:32], data[32:]]
    assert [w[1] for w in t.writes if len(w) == 8 and w[0] == 0] == [
        0x40, 0x42, 0x4c, 0x44, 0x44, 0x45, 0x48, 0x49, 0x4c, 0x4a]
    assert bytes.fromhex("00000040") in t.writes  # Read asked for exactly 2 lines


def test_scan_page_feeder_empty_still_releases(scripted):
    sense = bytes(4) + b"\x02\x3a" + bytes(26)
    t = scripted([_ok(0x40), _ok(0x42), _ok(0x4c), _ok(0x44),
                  bytes.fromhex("0044022b00000020") + sense, _ok(0x4c), _ok(0x4a)])
    with pytest.raises(FeederEmpty):
        list(scan_page(Scanner(t), ScanParams("adf", "gray", 75), 0x10000))
    assert t.writes[-1] == bytes.fromhex("004a000000000000")
    assert t.writes[-2] == b"\x80\x00\x00\x00"
