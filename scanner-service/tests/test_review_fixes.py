"""Regression tests for the final review findings (C1, I1-I9)."""
import contextlib
import os
import threading
import time
import urllib.request

import pytest

from scan3115.device import DeviceManager
from scan3115.jobs import JobRunner
from scan3115.protocol import ScanParams, Scanner
from scan3115.sim import SimulatedDevice


def wait_for(cond, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.01)
    return False


# C1 ------------------------------------------------------------------------------------

def test_poll_thread_survives_stale_bytes_and_recovers():
    sim = SimulatedDevice()
    sim._out += bytes.fromhex("0049000e00000000")  # stale late Read status in the pipe
    dm = DeviceManager(lambda: sim, poll_s=0.02)
    dm.start()
    try:
        assert wait_for(lambda: dm.state == "idle")
        assert dm._thread.is_alive()
    finally:
        dm.stop()


def test_scanerror_in_acquire_keeps_original_exception_and_state():
    sim = SimulatedDevice()
    dm = DeviceManager(lambda: sim, poll_s=0.02)
    dm.start()
    try:
        assert wait_for(lambda: dm.state == "idle")
        with pytest.raises(KeyError):
            with dm.acquire():
                sim._out += b"\x00\x99garbage"  # makes the post-scan refresh fail
                raise KeyError("original")
        assert dm.state in ("idle", "off")
        assert dm._thread.is_alive()
    finally:
        dm.stop()


# I1 ------------------------------------------------------------------------------------

def test_shutdown_cancels_and_releases_active_job(tmp_path):
    from scan3115.__main__ import shutdown
    gate = threading.Event()

    class Slow(SimulatedDevice):
        def read(self, size):
            if self._window is not None and self._lines_sent == 0 and not gate.is_set():
                gate.wait(0.5)
            return super().read(size)

    sim = Slow(adf_pages=3)
    dm = DeviceManager(lambda: sim, poll_s=0.02)
    dm.start()
    assert wait_for(lambda: dm.state == "idle")
    runner = JobRunner(dm.acquire, str(tmp_path))
    job = runner.start(ScanParams("adf", "gray", 75))
    shutdown(runner, dm, timeout=5)
    gate.set()
    assert job.done.is_set() and job.result.reason == "cancelled"
    assert sim.reserved is False


# I2 ------------------------------------------------------------------------------------

def test_purge_spool_removes_leftovers(tmp_path):
    (tmp_path / "abc123").mkdir()
    (tmp_path / "abc123" / "page-001.pnm").write_bytes(b"x")
    runner = JobRunner(lambda: None, str(tmp_path))
    assert runner.purge_spool() == 1
    assert os.listdir(tmp_path) == []


# I3 ------------------------------------------------------------------------------------

@pytest.mark.parametrize("p", [
    ScanParams("flatbed", "gray", 75, area_mm=(0, 0, 0.1, 0.1)),
    ScanParams("flatbed", "gray", 75, area_mm=(0, 0, 20, 0.1)),
    ScanParams("flatbed", "gray", 75, area_mm=(0, 0, float("nan"), 10)),
    ScanParams("flatbed", "gray", 75.0),
    ScanParams("flatbed", "gray", True),
])
def test_validate_rejects_degenerate_params(p):
    with pytest.raises(ValueError):
        p.validate()


# I4 ------------------------------------------------------------------------------------

def test_delete_active_job_removes_it_when_done(tmp_path):
    gate = threading.Event()

    class Slow(SimulatedDevice):
        def read(self, size):
            gate.wait(5)
            return super().read(size)

    sim = Slow()

    @contextlib.contextmanager
    def acquire():
        yield Scanner(sim, sleep=lambda _: None)

    runner = JobRunner(acquire, str(tmp_path))
    job = runner.start(ScanParams("flatbed", "gray", 75, area_mm=(0, 0, 10, 10)))
    assert runner.delete(job.id)
    assert runner.get(job.id) is None
    gate.set()
    assert job.done.wait(5)
    assert wait_for(lambda: not os.path.exists(os.path.join(tmp_path, job.id)))


# I5 ------------------------------------------------------------------------------------

def test_read_timeout_is_reported_as_timeout_and_keeps_device(tmp_path):
    class Hangs(SimulatedDevice):
        def read(self, size):
            if self._window is not None and self._lines_sent == 0 and self._page_no:
                self._window = None  # only the first Read hangs
                raise TimeoutError("timed out")
            return super().read(size)

    sim = Hangs()
    dm = DeviceManager(lambda: sim, poll_s=0.02)
    dm.start()
    try:
        assert wait_for(lambda: dm.state == "idle")
        runner = JobRunner(dm.acquire, str(tmp_path))
        job = runner.start(ScanParams("flatbed", "gray", 75, area_mm=(0, 0, 10, 10)))
        assert job.done.wait(5)
        assert job.result.reason == "error" and "timed out" in job.result.message
        assert wait_for(lambda: dm.state == "idle")
    finally:
        dm.stop()


def test_usb_read_timeout_is_generous():
    from scan3115.device import TIMEOUT_MS
    assert TIMEOUT_MS >= 90000  # lamp warm-up (~25 s) + first 256 KB Read


# I6 ------------------------------------------------------------------------------------

def test_spool_write_failure_is_not_a_disconnect(tmp_path, monkeypatch):
    import scan3115.pnm as pnm
    sim = SimulatedDevice()
    dm = DeviceManager(lambda: sim, poll_s=0.02)
    dm.start()
    try:
        assert wait_for(lambda: dm.state == "idle")
        real_open = open

        def failing_open(path, mode="r", *a, **k):
            if "w" in mode:
                raise OSError(28, "No space left on device")
            return real_open(path, mode, *a, **k)

        monkeypatch.setattr(pnm, "open", failing_open, raising=False)
        runner = JobRunner(dm.acquire, str(tmp_path))
        job = runner.start(ScanParams("flatbed", "gray", 75, area_mm=(0, 0, 10, 10)))
        assert job.done.wait(5)
        assert job.result.reason == "error" and job.result.message.startswith("spool write failed")
        assert sim.reserved is False
        assert dm.state == "idle"
    finally:
        dm.stop()


# I7 ------------------------------------------------------------------------------------

def test_start_failure_does_not_leave_runner_busy(tmp_path):
    spool = tmp_path / "not-a-dir"
    spool.write_text("file in the way")
    runner = JobRunner(lambda: None, str(spool))
    with pytest.raises(OSError):
        runner.start(ScanParams("flatbed", "gray", 75))
    assert not runner.busy and runner.jobs == {}


# I8 ------------------------------------------------------------------------------------

def test_sim_refills_feeder_after_empty():
    from scan3115.protocol import FeederEmpty, scan_page
    sim = SimulatedDevice(adf_pages=1, refill=True)
    s = Scanner(sim, sleep=lambda _: None)
    p = ScanParams("adf", "gray", 75)
    list(scan_page(s, p, 0x10000))
    with pytest.raises(FeederEmpty):
        list(scan_page(s, p, 0x10000))
    assert len(list(scan_page(s, p, 0x10000))) > 0  # refilled for the next batch


def test_sim_from_env():
    from scan3115.sim import sim_from_env
    sim = sim_from_env({"SCAN3115_SIM_PAGES": "4", "SCAN3115_SIM_JAM": "2:100"})
    assert sim.adf_pages == 4 and sim.jam_at == (2, 100) and sim.refill is True


def test_sim_jam_clears_itself_after_delay():
    sim = SimulatedDevice(adf_pages=1, jam_at=(1, 1), jam_clear_s=0.05)
    sim.jammed = True
    sim._jam_since = time.monotonic()
    time.sleep(0.1)
    Scanner(sim).test_unit_ready()  # no PaperJam: cover "opened and closed"


# I9 ------------------------------------------------------------------------------------

def test_no_cors_header_by_default(tmp_path):
    from tests.test_server import start_server
    srv, url = start_server(tmp_path, SimulatedDevice())
    try:
        with urllib.request.urlopen(url + "/api/status") as r:
            assert r.headers.get("Access-Control-Allow-Origin") is None
    finally:
        srv.shutdown()
