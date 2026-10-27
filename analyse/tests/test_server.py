# SPDX-License-Identifier: GPL-3.0-or-later
import json
import threading
import time
import urllib.error
import urllib.request

import cv2
import pytest

import synth
from deda_svc import report
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
            return r.status, r.headers, json.loads(r.read())
    except urllib.error.HTTPError as e:
        with e:
            return e.code, e.headers, json.loads(e.read())


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
