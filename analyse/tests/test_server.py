# SPDX-License-Identifier: GPL-3.0-or-later
import gzip
import logging
import json
import threading
import time
import urllib.error
import urllib.request

import cv2
import pytest

import synth
from deda_svc import report, server as server_mod
from deda_svc.server import serve


def _png(rgb) -> bytes:
    ok, png = cv2.imencode(".png", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_PNG_COMPRESSION, 1])
    assert ok
    return png.tobytes()


@pytest.fixture(scope="module")
def positive_png() -> bytes:
    return _png(synth.page(dpi=300, dots=synth.tdm_dots(300)))


@pytest.fixture
def base():
    srv = serve(0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()
    srv.server_close()


def call(url, method="GET", body=None, headers=None):
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, r.headers, _loads(r)
    except urllib.error.HTTPError as e:
        with e:
            return e.code, e.headers, _loads(e)


def _loads(r):
    raw = r.read()
    if r.headers.get("Content-Encoding") == "gzip":
        raw = gzip.decompress(raw)
    return json.loads(raw)


def test_health(base):
    status, headers, body = call(base + "/health")
    assert status == 200
    assert headers["Content-Type"] == "application/json"
    assert body == {"ok": True, "service": "analyse", "analyses": ["deda"]}


def test_positive_page(base, positive_png):
    status, _, body = call(base + "/deda/?dpi=300", "POST", positive_png)
    assert status == 200
    assert body["found"] is True
    assert body["dpi"] == 300


def test_default_dpi_is_600(base, monkeypatch):
    seen = []
    monkeypatch.setattr(report, "analyse", lambda data, dpi: seen.append(dpi) or {"ok": 1})
    assert call(base + "/deda/", "POST", b"x")[0] == 200
    assert seen == [600]


@pytest.mark.parametrize("q", ["dpi=100", "dpi=1201", "dpi=abc", "dpi="])
def test_bad_dpi(base, q):
    status, _, body = call(base + f"/deda/?{q}", "POST", b"x")
    assert status == 400
    assert body["error"] == "invalid"
    assert body["message"]


def test_garbage_body(base):
    status, _, body = call(base + "/deda/", "POST", b"not an image")
    assert (status, body["error"]) == (400, "invalid")


def test_empty_body(base):
    status, _, body = call(base + "/deda/", "POST", b"")
    assert (status, body["error"]) == (400, "invalid")


def test_too_large_rejected_without_reading(base):
    status, _, body = call(base + "/deda/", "POST", b"tiny", {"Content-Length": str(300 * 1024 * 1024)})
    assert (status, body) == (413, {"error": "too_large"})


def test_not_found(base):
    for method in ("GET", "POST"):
        status, _, body = call(base + "/nope", method, b"" if method == "POST" else None)
        assert (status, body) == (404, {"error": "not_found"})


def test_method_not_allowed(base):
    status, headers, body = call(base + "/deda/")
    assert (status, body["error"]) == (405, "method_not_allowed")
    assert headers["Allow"] == "POST"
    status, headers, _ = call(base + "/health", "POST", b"")
    assert status == 405
    assert headers["Allow"] == "GET"


def test_concurrent_requests_are_serialised(base, monkeypatch):
    state = {"running": 0, "overlap": False, "calls": 0}

    def fake(data, dpi):
        state["running"] += 1
        state["calls"] += 1
        state["overlap"] |= state["running"] > 1
        time.sleep(0.3)
        state["running"] -= 1
        return {"found": False}

    monkeypatch.setattr(report, "analyse", fake)
    results = []
    threads = [threading.Thread(target=lambda: results.append(call(base + "/deda/", "POST", b"x")[0]))
               for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results == [200, 200]
    assert state["calls"] == 2
    assert state["overlap"] is False


def test_second_body_is_not_read_while_analysis_runs(base, monkeypatch):
    events = []
    started, release = threading.Event(), threading.Event()

    def slow(data, dpi):
        events.append(f"analyse {len(data)}")
        started.set()
        release.wait(10)
        return {"found": False}

    class Recorder:
        def __init__(self, f):
            self._f = f

        def read(self, n):
            events.append(f"read {n}")
            return self._f.read(n)

        def __getattr__(self, name):
            return getattr(self._f, name)

    orig_setup = server_mod.Handler.setup

    def setup(self):
        orig_setup(self)
        self.rfile = Recorder(self.rfile)

    monkeypatch.setattr(report, "analyse", slow)
    monkeypatch.setattr(server_mod.Handler, "setup", setup)
    first = threading.Thread(target=lambda: call(base + "/deda/", "POST", b"a" * 3))
    first.start()
    assert started.wait(10)
    second = threading.Thread(target=lambda: call(base + "/deda/", "POST", b"b" * 5))
    second.start()
    time.sleep(0.5)  # the second handler is now waiting for the lock
    assert events == ["read 3", "analyse 3"]
    release.set()
    first.join()
    second.join()
    assert events == ["read 3", "analyse 3", "read 5", "analyse 5"]


def test_stalled_client_does_not_block_others(base, monkeypatch):
    import socket
    monkeypatch.setattr(server_mod.Handler, "timeout", 1)
    monkeypatch.setattr(report, "analyse", lambda data, dpi: {"found": False})
    stalled = socket.create_connection(("127.0.0.1", int(base.rsplit(":", 1)[1])))
    stalled.sendall(b"POST /deda/ HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nabc")
    time.sleep(0.2)
    t0 = time.monotonic()
    status, _, _ = call(base + "/deda/", "POST", b"x")
    assert status == 200
    assert time.monotonic() - t0 < 5
    stalled.close()


def _raw(base, path, body, headers):
    """Like call() but returns the undecoded response body too."""
    req = urllib.request.Request(base + path, data=body, method="POST", headers=headers)
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.status, r.headers, r.read()


def test_report_gzipped_when_accepted(base, monkeypatch):
    big = {"found": True, "images": {"overview": "A" * 5000}}
    monkeypatch.setattr(report, "analyse", lambda data, dpi: big)
    status, headers, raw = _raw(base, "/deda/", b"x", {"Accept-Encoding": "gzip"})
    assert status == 200
    assert headers["Content-Encoding"] == "gzip"
    assert headers["Vary"] == "Accept-Encoding"
    assert int(headers["Content-Length"]) == len(raw) < 1000
    assert json.loads(gzip.decompress(raw)) == big


def test_report_plain_without_accept_encoding(base, monkeypatch):
    big = {"found": True, "images": {"overview": "A" * 5000}}
    monkeypatch.setattr(report, "analyse", lambda data, dpi: big)
    status, headers, raw = _raw(base, "/deda/", b"x", {})
    assert status == 200
    assert headers["Content-Encoding"] is None
    assert headers["Vary"] == "Accept-Encoding"
    assert json.loads(raw) == big


@pytest.mark.parametrize("accept", ["gzip;q=0", "br, deflate", "identity", "*"])
def test_report_plain_when_gzip_refused(base, monkeypatch, accept):
    monkeypatch.setattr(report, "analyse", lambda data, dpi: {"pad": "A" * 5000})
    _, headers, raw = _raw(base, "/deda/", b"x", {"Accept-Encoding": accept})
    assert headers["Content-Encoding"] is None
    assert json.loads(raw)["pad"] == "A" * 5000


def test_small_body_stays_plain(base):
    req = urllib.request.Request(base + "/health", headers={"Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=10) as r:
        assert r.headers["Content-Encoding"] is None
        assert r.headers["Vary"] == "Accept-Encoding"
        assert json.loads(r.read())["ok"] is True


def test_health_gzipped_when_large_enough(base, monkeypatch):
    monkeypatch.setattr(server_mod, "GZIP_MIN", 1)
    req = urllib.request.Request(base + "/health", headers={"Accept-Encoding": "gzip, deflate;q=0.5"})
    with urllib.request.urlopen(req, timeout=10) as r:
        assert r.headers["Content-Encoding"] == "gzip"
        assert json.loads(gzip.decompress(r.read()))["ok"] is True


def test_gzip_request_body(base, positive_png):
    plain = call(base + "/deda/?dpi=300", "POST", positive_png)
    packed = call(base + "/deda/?dpi=300", "POST", gzip.compress(positive_png, 1),
                  {"Content-Encoding": "gzip", "Accept-Encoding": "gzip"})
    assert packed[0] == 200
    assert packed[1]["Content-Encoding"] == "gzip"
    assert packed[2]["found"] is plain[2]["found"] is True


def test_identity_content_encoding_ok(base, monkeypatch):
    monkeypatch.setattr(report, "analyse", lambda data, dpi: {"found": False})
    assert call(base + "/deda/", "POST", b"x", {"Content-Encoding": "identity"})[0] == 200


def test_gzip_bomb_rejected(base, monkeypatch):
    monkeypatch.setattr(server_mod, "MAX_BODY", 1024 * 1024)
    monkeypatch.setattr(report, "analyse", lambda data, dpi: pytest.fail("analyse must not run"))
    sizes = []
    real = server_mod.zlib.decompressobj

    class Obj:
        def __init__(self, *a, **k):
            self._o = real(*a, **k)

        def decompress(self, data, max_length=0):
            out = self._o.decompress(data, max_length)
            sizes.append(len(out))
            return out

        def __getattr__(self, n):
            return getattr(self._o, n)

    monkeypatch.setattr(server_mod.zlib, "decompressobj", lambda *a, **k: Obj(*a, **k))
    bomb = gzip.compress(bytes(16 * 1024 * 1024))
    assert len(bomb) < 100_000
    status, _, body = call(base + "/deda/", "POST", bomb, {"Content-Encoding": "gzip"})
    assert (status, body) == (413, {"error": "too_large"})
    assert len(sizes) >= 2
    assert max(sizes) <= server_mod.CHUNK  # every step is bounded
    assert sum(sizes) <= 1024 * 1024 + server_mod.CHUNK  # never decompressed far past the limit


def test_corrupt_gzip_body(base):
    for body in (b"definitely not gzip", gzip.compress(b"x" * 1000)[:-20]):
        status, _, out = call(base + "/deda/", "POST", body, {"Content-Encoding": "gzip"})
        assert (status, out) == (400, {"error": "invalid", "message": "bad gzip body"})


def test_unknown_content_encoding(base):
    status, _, body = call(base + "/deda/", "POST", b"x", {"Content-Encoding": "br"})
    assert (status, body) == (415, {"error": "unsupported_encoding"})


def test_accept_encoding_case_insensitive(base, monkeypatch):
    monkeypatch.setattr(report, "analyse", lambda data, dpi: {"pad": "A" * 5000})
    _, headers, raw = _raw(base, "/deda/", b"x", {"Accept-Encoding": "GZIP"})
    assert headers["Content-Encoding"] == "gzip"
    assert json.loads(gzip.decompress(raw))["pad"] == "A" * 5000


def _member_of_size(size: int) -> bytes:
    """A gzip member (stored blocks, so size is predictable) of exactly `size` bytes."""
    n = size - 18
    while len(m := gzip.compress(bytes(n), 0)) != size:
        n -= len(m) - size
    return m


@pytest.mark.parametrize("head,tail", [(gzip.compress(b"x" * 1000), b"junk"),
                                       (_member_of_size(65536), b"junk"),  # garbage starts in the 2nd slice
                                       (_member_of_size(65536), bytes(200_000))])
def test_trailing_data_after_gzip_rejected(base, monkeypatch, head, tail):
    monkeypatch.setattr(report, "analyse", lambda data, dpi: pytest.fail("analyse must not run"))
    status, _, out = call(base + "/deda/", "POST", head + tail, {"Content-Encoding": "gzip"})
    assert (status, out) == (400, {"error": "invalid", "message": "bad gzip body"})


def test_health_checks_log_only_at_debug(base, caplog):
    # Docker polls /health every 30 s: at info that would be one line per poll.
    with caplog.at_level(logging.INFO, logger="deda_svc.server"):
        call(base + "/health")
    assert not [r for r in caplog.records if "/health" in r.getMessage()]
    with caplog.at_level(logging.DEBUG, logger="deda_svc.server"):
        call(base + "/health")
    assert [r.levelname for r in caplog.records if "/health" in r.getMessage()] == ["DEBUG"]
