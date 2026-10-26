import contextlib
import gzip
import json
import threading
import urllib.error
import urllib.request

import pytest

from scan3115 import __version__
from scan3115.jobs import JobRunner
from scan3115.protocol import Scanner
from scan3115.server import StatusHub, make_server
from scan3115.sim import SimulatedDevice


def start_server(tmp_path, device, printer="idle"):
    @contextlib.contextmanager
    def acquire():
        yield Scanner(device, sleep=lambda _: None)

    hub = StatusHub()
    runner = JobRunner(acquire, str(tmp_path))

    def status():
        return {"service": "scan3115", "version": __version__,
                "printer": printer if printer == "off" else ("scanning" if runner.busy else "idle"),
                "paper_in_feeder": False, "job": runner.active.id if runner.active else None}

    srv = make_server(runner, status, hub, "127.0.0.1", 0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


@pytest.fixture
def server(tmp_path):
    srv, url = start_server(tmp_path, SimulatedDevice(adf_pages=2))
    yield url
    srv.shutdown()


@pytest.fixture
def server_off(tmp_path):
    srv, url = start_server(tmp_path, SimulatedDevice(), printer="off")
    yield url
    srv.shutdown()


def request(url, method="GET", body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read(), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def get_json(base, path):
    code, body, _ = request(base + path)
    assert code == 200
    return json.loads(body)


def post_json(base, path, body):
    code, data, _ = request(base + path, "POST", body)
    return code, json.loads(data) if data else None


def read_sse(base, path, until="done", limit=50):
    events = []
    with urllib.request.urlopen(base + path, timeout=10) as r:
        event = None
        for raw in r:
            line = raw.decode().rstrip("\n")
            if line.startswith("event: "):
                event = line[7:]
            elif line.startswith("data: "):
                events.append((event, json.loads(line[6:])))
                if event == until or len(events) >= limit:
                    break
    return events


def test_status_shape(server):
    s = get_json(server, "/api/status")
    assert s["service"] == "scan3115" and s["printer"] in {"idle", "off", "scanning", "jammed"}


def test_scan_flow_events_and_pages(server):
    code, body = post_json(server, "/api/scans", {"source": "adf", "mode": "gray", "dpi": 75})
    assert code == 202
    sid = body["id"]
    events = read_sse(server, f"/api/scans/{sid}/events")
    assert [e for e, _ in events].count("page") == 2
    assert events[-1] == ("done", {"reason": "complete", "message": "", "pages": 2})
    code, data, headers = request(server + f"/api/scans/{sid}/pages/1", headers={"Accept-Encoding": "gzip"})
    assert code == 200 and headers.get("Content-Encoding") == "gzip"
    assert gzip.decompress(data).startswith(b"P5\n")
    info = get_json(server, f"/api/scans/{sid}")
    assert info["state"] == "done" and len(info["pages"]) == 2 and info["result"]["reason"] == "complete"


def test_invalid_params_400(server):
    for bad in [{"source": "flatbed", "mode": "gray", "dpi": 123},
                {"source": "flatbed", "mode": "sepia", "dpi": 150},
                {"source": "flatbed", "mode": "gray", "dpi": 150, "area_mm": [0, 0, 300, 10]},
                {"source": "flatbed"}]:
        code, body = post_json(server, "/api/scans", bad)
        assert code == 400 and body["error"] == "invalid" and body["message"]
    code, _, _ = request(server + "/api/scans", "POST", None, {"Content-Type": "application/json"})
    assert code == 400


def test_concurrent_scan_requests_one_wins(tmp_path):
    gate = threading.Event()

    class Slow(SimulatedDevice):
        def read(self, size):
            gate.wait(5)
            return super().read(size)

    srv, url = start_server(tmp_path, Slow())
    codes = []
    barrier = threading.Barrier(2)

    def go():
        barrier.wait()
        codes.append(post_json(url, "/api/scans", {"source": "flatbed", "mode": "gray", "dpi": 75})[0])

    threads = [threading.Thread(target=go) for _ in range(2)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    gate.set()
    srv.shutdown()
    assert sorted(codes) == [202, 409]


def test_printer_off_503(server_off):
    code, body = post_json(server_off, "/api/scans", {"source": "flatbed", "mode": "gray", "dpi": 75})
    assert code == 503 and body["error"] == "printer_off"


def test_cancel_and_delete(server):
    code, body = post_json(server, "/api/scans", {"source": "adf", "mode": "gray", "dpi": 75})
    sid = body["id"]
    assert request(server + f"/api/scans/{sid}/cancel", "POST")[0] == 202
    done = read_sse(server, f"/api/scans/{sid}/events")[-1]
    assert done[0] == "done" and done[1]["reason"] in ("cancelled", "complete")
    assert request(server + f"/api/scans/{sid}", "DELETE")[0] == 204
    assert request(server + f"/api/scans/{sid}")[0] == 404


def test_unknown_scan_404(server):
    assert request(server + "/api/scans/nope")[0] == 404
    assert request(server + "/api/scans/nope/pages/1")[0] == 404


def test_status_sse_sends_snapshot_on_connect(server):
    events = read_sse(server, "/api/events", until="status")
    assert events[0][0] == "status" and events[0][1]["service"] == "scan3115"
