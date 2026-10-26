import pytest

from scan3115.protocol import FeederEmpty, PaperJam, ScanParams, Scanner, compute_geometry, scan_page
from scan3115.sim import SimulatedDevice


def nosleep(_):
    pass


def test_flatbed_page_has_requested_lines():
    p = ScanParams("flatbed", "gray", 75, area_mm=(0, 0, 25.4, 25.4))
    lines = list(scan_page(Scanner(SimulatedDevice()), p, 0x40000))
    assert len(lines) == 75 and all(len(l) == compute_geometry(p).line_bytes for l in lines)


def test_adf_three_pages_then_feeder_empty():
    dev = SimulatedDevice(adf_pages=3)
    s = Scanner(dev, sleep=nosleep)
    p = ScanParams("adf", "gray", 75)
    for _ in range(3):
        assert len(list(scan_page(s, p, 0x10000))) == compute_geometry(p).lines
    with pytest.raises(FeederEmpty):
        list(scan_page(s, p, 0x10000))


def test_jam_persists_until_cleared():
    dev = SimulatedDevice(adf_pages=2, jam_at=(1, 40))
    s = Scanner(dev, sleep=nosleep)
    with pytest.raises(PaperJam):
        list(scan_page(s, ScanParams("adf", "gray", 75), 0x10000))
    with pytest.raises(PaperJam):
        s.test_unit_ready()
    dev.clear_jam()
    s.test_unit_ready()


def test_short_page_ends_early():
    dev = SimulatedDevice(adf_pages=1, short_page_lines=500)
    lines = list(scan_page(Scanner(dev), ScanParams("adf", "gray", 75, paper="legal"), 0x10000))
    assert len(lines) == 500


def test_paper_flag():
    s = Scanner(SimulatedDevice(adf_pages=1))
    s.test_unit_ready()
    assert s.paper_in_feeder


def test_released_after_page():
    dev = SimulatedDevice()
    list(scan_page(Scanner(dev), ScanParams("flatbed", "gray", 75, area_mm=(0, 0, 10, 10)), 0x40000))
    assert dev.reserved is False
