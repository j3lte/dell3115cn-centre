import contextlib
import os
import threading

import pytest

from scan3115.jobs import JobRunner
from scan3115.protocol import Busy, ScanParams, Scanner
from scan3115.sim import SimulatedDevice


def make_runner(tmp_path, transport=None, clock=None, **sim):
    dev = transport or SimulatedDevice(**sim)

    @contextlib.contextmanager
    def acquire():
        yield Scanner(dev, sleep=lambda _: None)

    kw = {"clock": clock} if clock else {}
    return JobRunner(acquire, str(tmp_path), **kw), dev


def wait(job, timeout=10):
    assert job.done.wait(timeout), "job did not finish"


def test_adf_job_three_pages_complete(tmp_path):
    runner, _ = make_runner(tmp_path, adf_pages=3)
    job = runner.start(ScanParams("adf", "gray", 75)); wait(job)
    assert job.result.reason == "complete" and len(job.pages) == 3
    assert open(job.pages[0].path, "rb").read(3) == b"P5\n"


def test_adf_empty_feeder(tmp_path):
    runner, _ = make_runner(tmp_path, adf_pages=0)
    job = runner.start(ScanParams("adf", "gray", 75)); wait(job)
    assert job.result.reason == "feeder_empty" and job.result.pages == 0
    assert job.result.message == "No paper in the feeder"


def test_jam_keeps_pages_and_reports(tmp_path):
    runner, _ = make_runner(tmp_path, adf_pages=5, jam_at=(4, 10))
    job = runner.start(ScanParams("adf", "gray", 75)); wait(job)
    assert job.result.reason == "jam" and job.result.pages == 3
    assert "after page 3" in job.result.message
    assert sorted(os.listdir(os.path.dirname(job.pages[0].path))) == ["page-001.pnm", "page-002.pnm", "page-003.pnm"]


def test_busy_while_running(tmp_path):
    gate = threading.Event()

    class Slow(SimulatedDevice):
        def read(self, size):
            gate.wait(5)
            return super().read(size)

    runner, _ = make_runner(tmp_path, transport=Slow())
    job = runner.start(ScanParams("flatbed", "gray", 75))
    with pytest.raises(Busy):
        runner.start(ScanParams("flatbed", "gray", 75))
    gate.set(); wait(job)
    assert not runner.busy


def test_cancel_mid_scan(tmp_path):
    runner, dev = make_runner(tmp_path, adf_pages=3)
    job = runner.start(ScanParams("adf", "gray", 75))
    job.cancel(); wait(job)
    assert job.result.reason == "cancelled" and dev.reserved is False


def test_subscribe_replays_events(tmp_path):
    runner, _ = make_runner(tmp_path, adf_pages=2)
    job = runner.start(ScanParams("adf", "gray", 75)); wait(job)
    q = job.subscribe()
    events = [q.get_nowait() for _ in range(3)]
    assert [e for e, _ in events] == ["page", "page", "done"]


def test_usb_error_mid_scan_ends_job(tmp_path):
    class Unplugged(SimulatedDevice):
        reads = 0

        def read(self, size):
            self.reads += 1
            if self.reads > 9:
                raise OSError(19, "No such device")
            return super().read(size)

    runner, _ = make_runner(tmp_path, transport=Unplugged(adf_pages=3))
    job = runner.start(ScanParams("adf", "gray", 75)); wait(job)
    assert job.result.reason == "error" and job.result.message == "printer disconnected"


def test_spool_cleanup_after_ttl(tmp_path):
    now = [1000.0]
    runner, _ = make_runner(tmp_path, clock=lambda: now[0], adf_pages=1)
    job = runner.start(ScanParams("adf", "gray", 75)); wait(job)
    assert runner.cleanup() == 0
    now[0] += 3601
    assert runner.cleanup() == 1
    assert runner.get(job.id) is None and not os.path.exists(os.path.join(tmp_path, job.id))


def test_short_page_completes(tmp_path):
    runner, _ = make_runner(tmp_path, adf_pages=1, short_page_lines=500)
    job = runner.start(ScanParams("adf", "gray", 75, paper="legal")); wait(job)
    assert job.result.reason == "complete" and job.pages[0].height == 500


def test_color_pnm_is_interleaved(tmp_path):
    runner, _ = make_runner(tmp_path)
    job = runner.start(ScanParams("flatbed", "color", 75, area_mm=(0, 0, 10, 10))); wait(job)
    data = open(job.pages[0].path, "rb").read()
    assert data.startswith(b"P6\n30 30\n255\n") and data.endswith(b"\x01\x02\x03")


def test_delete_removes_spool(tmp_path):
    runner, _ = make_runner(tmp_path)
    job = runner.start(ScanParams("flatbed", "gray", 75, area_mm=(0, 0, 10, 10))); wait(job)
    assert runner.delete(job.id) and not os.path.exists(os.path.join(tmp_path, job.id))
