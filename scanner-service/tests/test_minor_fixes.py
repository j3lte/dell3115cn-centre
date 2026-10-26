"""Regression tests for the deferred minor review findings."""
import contextlib
import http.client
import os
import queue
import socket
import struct
import threading
import urllib.parse

import pytest

from scan3115.device import DeviceManager
from scan3115.jobs import Job, JobRunner, PageInfo
from scan3115.pnm import write_pnm
from scan3115.protocol import ScanParams, Scanner
from scan3115.server import StatusHub, accepts_gzip, make_server
from scan3115.sim import SimulatedDevice
from tests.test_server import server  # noqa: F401 — fixture


def _record_puts(q: queue.Queue, record) -> None:
    """Call record(event) at the moment the job thread puts an event on q."""
    put = q.put

    def recording_put(item, *a, **kw):
        record(item)
        put(item, *a, **kw)

    q.put = recording_put


# Job inactive before `done` ------------------------------------------------------------

def test_job_is_inactive_when_done_is_published(tmp_path):
    gate = threading.Event()
    dev = SimulatedDevice()

    @contextlib.contextmanager
    def acquire():
        gate.wait(5)
        yield Scanner(dev, sleep=lambda _: None)

    runner = JobRunner(acquire, str(tmp_path))
    job = runner.start(ScanParams("flatbed", "gray", 75, area_mm=(0, 0, 10, 10)))
    busy_at_done = []
    _record_puts(job.subscribe(), lambda e: e[0] == "done" and busy_at_done.append(runner.busy))
    gate.set()
    assert job.done.wait(10)
    assert busy_at_done == [False]


# Request body cap ----------------------------------------------------------------------

def _post_raw(base, content_length, body=b""):
    """POST /api/scans with a declared Content-Length and (possibly less) body; returns the status."""
    u = urllib.parse.urlparse(base)
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=3)
    try:
        conn.putrequest("POST", "/api/scans")
        conn.putheader("Content-Type", "application/json")
        conn.putheader("Content-Length", str(content_length))
        conn.endheaders()
        if body:
            conn.send(body)
        return conn.getresponse().status
    finally:
        conn.close()


def test_oversized_body_is_refused_without_reading_it(server):
    assert _post_raw(server, 10 * 1024 * 1024) == 413


def test_negative_content_length_is_invalid(server):
    assert _post_raw(server, -1) == 400


# Accept-Encoding q-values, quiet client abort -------------------------------------------

@pytest.mark.parametrize("header, expected", [
    (None, False),
    ("", False),
    ("gzip", True),
    ("gzip, deflate, br", True),
    ("GZIP;Q=0.5", True),
    ("gzip;q=0", False),
    ("gzip; q=0.000", False),
    ("deflate, gzip;q=0", False),
    ("*", True),
    ("*;q=0", False),
    ("br, *;q=0.1", True),
    ("gzip;q=0, *", False),  # an explicit gzip entry wins over the wildcard
    ("identity", False),
    ("x-gzipped", False),
    ("gzip;q=bogus", False),
])
def test_accepts_gzip(header, expected):
    assert accepts_gzip(header) is expected


def test_page_not_gzipped_when_gzip_has_q_zero(server):
    from tests.test_server import post_json, read_sse, request

    code, body = post_json(server, "/api/scans", {"source": "adf", "mode": "gray", "dpi": 75})
    assert code == 202
    read_sse(server, f"/api/scans/{body['id']}/events")
    code, data, headers = request(server + f"/api/scans/{body['id']}/pages/1",
                                  headers={"Accept-Encoding": "gzip;q=0"})
    assert code == 200 and headers.get("Content-Encoding") is None
    assert data.startswith(b"P5\n")


@pytest.mark.parametrize("encoding", ["gzip", "identity"])
def test_client_abort_during_page_download_is_quiet(tmp_path, encoding):
    page_path = tmp_path / "page.pnm"
    header = b"P5\n4096 4096\n255\n"
    page_path.write_bytes(header + os.urandom(4096 * 4096))  # incompressible: gzip can't fit in socket buffers
    size = page_path.stat().st_size
    runner = JobRunner(lambda: None, str(tmp_path))
    job = Job("abcdef", ScanParams("flatbed", "gray", 75), 0)
    job.pages.append(PageInfo(1, 4096, 4096, "gray", str(page_path), size))
    runner.jobs[job.id] = job
    srv = make_server(runner, lambda: {}, StatusHub(), "127.0.0.1", 0)
    errors, finished = [], threading.Event()
    srv.handle_error = lambda request, address: errors.append(address)
    shutdown_request = srv.shutdown_request

    def note_finished(request):
        shutdown_request(request)
        finished.set()

    srv.shutdown_request = note_finished
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        c = socket.create_connection(srv.server_address, timeout=5)
        c.sendall(f"GET /api/scans/{job.id}/pages/1 HTTP/1.1\r\nHost: x\r\n"
                  f"Accept-Encoding: {encoding}\r\n\r\n".encode())
        assert c.recv(4096).startswith(b"HTTP/1.")
        c.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))  # close with RST
        c.close()
        assert finished.wait(10), "handler did not finish"
        assert errors == []
    finally:
        srv.shutdown()
        srv.server_close()


# Pages written once ----------------------------------------------------------------------

def _parse_pnm(data: bytes):
    """Minimal spec-following PNM header parser: (magic, width, height, maxval, data offset)."""
    fields = 3 if data[:2] == b"P4" else 4
    tokens, i = [], 0
    while len(tokens) < fields:
        while data[i:i + 1].isspace():
            i += 1
        start = i
        while not data[i:i + 1].isspace():
            i += 1
        tokens.append(data[start:i])
    i += 1  # exactly one whitespace byte before the raster
    return tokens[0], int(tokens[1]), int(tokens[2]), int(tokens[3]) if fields == 4 else None, i


def _count_writes(monkeypatch):
    import scan3115.pnm as pnm
    written = [0]
    real_open = open

    class Counting:
        def __init__(self, f):
            self._f = f

        def write(self, b):
            written[0] += len(b)
            return self._f.write(b)

        def __getattr__(self, name):
            return getattr(self._f, name)

        def __enter__(self):
            self._f.__enter__()
            return self

        def __exit__(self, *exc):
            return self._f.__exit__(*exc)

    def counting_open(path, mode="r", *a, **k):
        f = real_open(path, mode, *a, **k)
        return Counting(f) if any(c in mode for c in "wa+") else f

    monkeypatch.setattr(pnm, "open", counting_open, raising=False)
    return written


def test_write_pnm_writes_each_byte_once(tmp_path, monkeypatch):
    written = _count_writes(monkeypatch)
    path = str(tmp_path / "page.pnm")
    rows = [bytes([i]) * 64 for i in range(100)]
    assert write_pnm(path, "gray", 64, 64, rows, max_lines=100) == 100
    size = os.path.getsize(path)
    assert size <= written[0] <= size + len(b"P5\n64 100\n255\n")  # only the header is rewritten


def test_write_pnm_final_file_appears_only_when_complete(tmp_path):
    path = str(tmp_path / "page.pnm")

    def rows():
        for i in range(10):
            assert not os.path.exists(path)
            yield bytes(8)

    write_pnm(path, "gray", 8, 8, rows(), max_lines=10)
    assert os.listdir(tmp_path) == ["page.pnm"]


@pytest.mark.parametrize("mode, row, maxval", [("lineart", b"\xaa", None), ("gray", bytes(8), 255),
                                               ("color", bytes(24), 255)])
def test_write_pnm_short_page_header(tmp_path, mode, row, maxval):
    path = str(tmp_path / "page.pnm")
    assert write_pnm(path, mode, 8, 8, [row] * 7, max_lines=1200) == 7
    data = open(path, "rb").read()
    magic, width, height, mv, offset = _parse_pnm(data)
    assert (width, height, mv) == (8, 7, maxval)
    assert len(data) - offset == 7 * len(row if mode != "color" else bytes(24))


def test_write_pnm_full_page_header_is_plain(tmp_path):
    path = str(tmp_path / "page.pnm")
    write_pnm(path, "gray", 8, 8, [bytes(8)] * 1200, max_lines=1200)
    assert open(path, "rb").read(14) == b"P5\n8 1200\n255\n"


def test_short_adf_page_has_its_real_height(tmp_path):
    dev = SimulatedDevice(adf_pages=1, short_page_lines=9)

    @contextlib.contextmanager
    def acquire():
        yield Scanner(dev, sleep=lambda _: None)

    runner = JobRunner(acquire, str(tmp_path))
    job = runner.start(ScanParams("adf", "gray", 75))
    assert job.done.wait(10) and job.result.reason == "complete"
    page = job.pages[0]
    data = open(page.path, "rb").read()
    magic, width, height, maxval, offset = _parse_pnm(data)
    assert (magic, width, height, page.height) == (b"P5", page.width, 9, 9)
    assert len(data) - offset == width * 9 and page.bytes == len(data)


def test_write_pnm_error_mid_page_leaves_nothing(tmp_path):
    def rows():
        yield bytes(8)
        raise TimeoutError("scanner went quiet")

    with pytest.raises(TimeoutError):
        write_pnm(str(tmp_path / "page.pnm"), "gray", 8, 8, rows(), max_lines=10)
    assert os.listdir(tmp_path) == []


# TCP keep-alive, dead SSE peers ----------------------------------------------------------

def test_accepted_sockets_use_tcp_keepalive(tmp_path):
    srv = make_server(JobRunner(lambda: None, str(tmp_path)), lambda: {}, StatusHub(), "127.0.0.1", 0)
    try:
        c = socket.create_connection(srv.server_address, timeout=5)
        conn, _ = srv.get_request()
        try:
            assert conn.getsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE) != 0
            if hasattr(socket, "TCP_KEEPIDLE"):
                assert 0 < conn.getsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE) <= 120
            if hasattr(socket, "TCP_KEEPCNT"):
                assert 0 < conn.getsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT) <= 10
        finally:
            conn.close()
            c.close()
    finally:
        srv.server_close()


def test_status_events_exit_on_dead_peer(tmp_path, monkeypatch):
    import time

    import scan3115.server as server_mod
    monkeypatch.setattr(server_mod, "PING_S", 0.05)
    hub = StatusHub()
    srv = make_server(JobRunner(lambda: None, str(tmp_path)), lambda: {"printer": "idle"}, hub, "127.0.0.1", 0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        c = socket.create_connection(srv.server_address, timeout=5)
        c.sendall(b"GET /api/events HTTP/1.1\r\nHost: x\r\n\r\n")
        got = b""
        while b"event: status" not in got:
            chunk = c.recv(4096)
            assert chunk, "connection closed before the status event"
            got += chunk
        assert len(hub._subs) == 1
        c.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        c.close()
        end = time.monotonic() + 3
        while hub._subs and time.monotonic() < end:
            time.sleep(0.01)
        assert hub._subs == []
    finally:
        srv.shutdown()
        srv.server_close()


# USB handle released when claiming fails -------------------------------------------------

class _FakeDev:
    def is_kernel_driver_active(self, interface):
        return False


def test_usb_open_disposes_device_when_claim_fails(monkeypatch):
    import usb.core
    import usb.util

    from scan3115.device import UsbTransport

    dev, disposed = _FakeDev(), []

    def claim(d, interface):
        assert interface == 0
        raise usb.core.USBError("Resource busy")

    monkeypatch.setattr(usb.core, "find", lambda **kw: dev)
    monkeypatch.setattr(usb.util, "claim_interface", claim)
    monkeypatch.setattr(usb.util, "release_interface", lambda d, i: pytest.fail("interface was never claimed"))
    monkeypatch.setattr(usb.util, "dispose_resources", disposed.append)
    with pytest.raises(usb.core.USBError):
        UsbTransport.open()
    assert disposed == [dev]


def test_usb_open_disposes_device_when_detach_fails(monkeypatch):
    import usb.core
    import usb.util

    from scan3115.device import UsbTransport

    class Attached(_FakeDev):
        def is_kernel_driver_active(self, interface):
            return True

        def detach_kernel_driver(self, interface):
            raise usb.core.USBError("Access denied")

    dev, disposed = Attached(), []
    monkeypatch.setattr(usb.core, "find", lambda **kw: dev)
    monkeypatch.setattr(usb.util, "dispose_resources", disposed.append)
    with pytest.raises(usb.core.USBError):
        UsbTransport.open()
    assert disposed == [dev]


# paper_in_feeder follows the status bytes during a scan ----------------------------------

def test_paper_in_feeder_follows_status_flags_while_scanning(tmp_path):
    from tests.test_review_fixes import wait_for

    sim = SimulatedDevice(adf_pages=2)
    published = []
    dm = DeviceManager(lambda: sim, poll_s=0.02,
                       on_change=lambda: published.append((dm.state, dm.paper_in_feeder)))
    dm.start()
    try:
        assert wait_for(lambda: dm.state == "idle" and dm.paper_in_feeder)
        gate = threading.Event()

        @contextlib.contextmanager
        def acquire():
            gate.wait(5)  # subscribe before the first page
            with dm.acquire() as scanner:
                yield scanner

        runner = JobRunner(acquire, str(tmp_path))
        job = runner.start(ScanParams("adf", "gray", 75))
        at_page = []
        _record_puts(job.subscribe(), lambda e: e[0] == "page" and at_page.append(dm.paper_in_feeder))
        gate.set()
        assert job.done.wait(10) and job.result.reason == "complete"
        assert at_page == [True, False]  # one sheet left after page 1, tray empty after page 2
        assert ("scanning", False) in published  # clients are told while the scan is still running
        assert dm.paper_in_feeder is False
    finally:
        dm.stop()
