"""HTTP + server-sent-events API (stdlib only).

Routes (contract shared with the webapp):
  GET    /api/status                  scanner status
  GET    /api/events                  SSE: status (snapshot + changes), button, pings
  POST   /api/scans                   start a scan → 202 {id}; 400 invalid, 409 busy, 413 too_large, 503 printer_off
  GET    /api/scans/{id}              job state, pages, result
  GET    /api/scans/{id}/events       SSE: page, done (replayed; closes after done)
  GET    /api/scans/{id}/pages/{n}    page as PNM (gzip when accepted)
  POST   /api/scans/{id}/cancel       202
  DELETE /api/scans/{id}              204, removes spool files
"""

import json
import logging
import os
import queue
import re
import socket
import threading
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable

from .jobs import Job, JobRunner
from .protocol import Busy, PrinterOff, ScanParams

log = logging.getLogger(__name__)
PING_S = 15.0
MAX_BODY = 64 * 1024  # requests are small JSON objects
# A client that vanishes without closing (Wi-Fi drop, sleep) would hold an SSE thread until TCP gives up
# (~15 min on Linux). Keep-alive probes find an idle dead peer in ~2 min; TCP_USER_TIMEOUT (Linux) does the
# same for unacknowledged data such as an SSE ping, so the next ping write fails and the loop exits.
KEEPALIVE = ((socket.SOL_SOCKET, "SO_KEEPALIVE", 1), (socket.IPPROTO_TCP, "TCP_KEEPIDLE", 60),
             (socket.IPPROTO_TCP, "TCP_KEEPINTVL", 15), (socket.IPPROTO_TCP, "TCP_KEEPCNT", 4),
             (socket.IPPROTO_TCP, "TCP_USER_TIMEOUT", 120_000))


def _enable_keepalive(sock: socket.socket) -> None:
    """Set the KEEPALIVE options the platform has (TCP_KEEPIDLE and TCP_USER_TIMEOUT are Linux-only)."""
    for level, name, value in KEEPALIVE:
        if hasattr(socket, name):
            try:
                sock.setsockopt(level, getattr(socket, name), value)
            except OSError as e:
                log.debug("setsockopt %s failed: %s", name, e)


class _Server(ThreadingHTTPServer):
    daemon_threads = True

    def get_request(self):
        conn, addr = super().get_request()
        _enable_keepalive(conn)
        return conn, addr


class StatusHub:
    """Fan-out of status/button events to SSE subscribers."""

    def __init__(self):
        self._lock = threading.Lock()
        self._subs: list[queue.Queue] = []

    def publish(self, event: str, data: dict) -> None:
        with self._lock:
            for q in self._subs:
                q.put((event, data))

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue()
        with self._lock:
            self._subs.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            if q in self._subs:
                self._subs.remove(q)


def accepts_gzip(header: str | None) -> bool:
    """True if an Accept-Encoding header allows gzip (RFC 9110: q=0 means "not acceptable").

    An explicit gzip entry decides; otherwise a `*` entry does. A malformed q-value counts as 0.
    """
    explicit = wildcard = None
    for item in (header or "").split(","):
        coding, *params = (part.strip() for part in item.split(";"))
        q = 1.0
        for param in params:
            name, _, value = param.partition("=")
            if name.strip().lower() == "q":
                try:
                    q = float(value)
                except ValueError:
                    q = 0.0
        coding = coding.lower()
        if coding in ("gzip", "x-gzip"):
            explicit = q > 0
        elif coding == "*":
            wildcard = q > 0
    if explicit is not None:
        return explicit
    return bool(wildcard)


def _page_json(p) -> dict:
    return {"n": p.n, "width": p.width, "height": p.height, "mode": p.mode, "depth": p.depth}


def _result_json(r) -> dict:
    return {"reason": r.reason, "message": r.message, "pages": r.pages}


def _job_json(job: Job) -> dict:
    return {
        "id": job.id,
        "state": "done" if job.result else "running",
        "pages": [dict(_page_json(p), bytes=p.bytes) for p in job.pages],
        "result": _result_json(job.result) if job.result else None,
    }


def _parse_params(body: dict) -> ScanParams:
    if not isinstance(body, dict):
        raise ValueError("body must be a JSON object")
    for key in ("source", "mode", "dpi"):
        if key not in body:
            raise ValueError(f"missing field {key!r}")
    area = body.get("area_mm")
    p = ScanParams(
        source=body["source"], mode=body["mode"], dpi=body["dpi"],
        area_mm=tuple(float(v) for v in area) if area is not None else None,
        paper=body.get("paper", "a4"), threshold=int(body.get("threshold", 0xC3)),
        depth=body.get("depth", 8),
    )
    p.validate()
    return p


def make_server(runner: JobRunner, status: Callable[[], dict], hub: StatusHub,
                host: str, port: int, cors_origin: str | None = None) -> ThreadingHTTPServer:
    """cors_origin: value for Access-Control-Allow-Origin; None (default) sends no CORS headers."""

    class Handler(BaseHTTPRequestHandler):
        server_version = "scan3115"

        def log_message(self, fmt, *args):
            log.debug("%s " + fmt, self.address_string(), *args)

        # --- helpers -----------------------------------------------------------------

        def _cors(self) -> None:
            if cors_origin:
                self.send_header("Access-Control-Allow-Origin", cors_origin)

        def _json(self, code: int, obj) -> None:
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self._cors()
            self.end_headers()
            self.wfile.write(body)

        def _empty(self, code: int) -> None:
            self.send_response(code)
            self.send_header("Content-Length", "0")
            self._cors()
            self.end_headers()

        def _sse_start(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self._cors()
            self.end_headers()

        def _sse(self, event: str, data) -> None:
            self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())
            self.wfile.flush()

        def _job(self, job_id: str) -> Job | None:
            job = runner.get(job_id)
            if job is None:
                self._json(404, {"error": "not_found"})
            return job

        # --- routes --------------------------------------------------------------------

        def do_OPTIONS(self):
            self.send_response(204)
            if cors_origin:
                self._cors()
                self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/api/status":
                return self._json(200, status())
            if path == "/api/events":
                return self._status_events()
            if m := re.fullmatch(r"/api/scans/([0-9a-f]+)", path):
                if job := self._job(m[1]):
                    self._json(200, _job_json(job))
                return
            if m := re.fullmatch(r"/api/scans/([0-9a-f]+)/events", path):
                if job := self._job(m[1]):
                    self._job_events(job)
                return
            if m := re.fullmatch(r"/api/scans/([0-9a-f]+)/pages/(\d+)", path):
                if job := self._job(m[1]):
                    self._page(job, int(m[2]))
                return
            self._json(404, {"error": "not_found"})

        def do_POST(self):
            path = self.path.split("?", 1)[0]
            if path == "/api/scans":
                return self._start_scan()
            if m := re.fullmatch(r"/api/scans/([0-9a-f]+)/cancel", path):
                if job := self._job(m[1]):
                    job.cancel()
                    self._empty(202)
                return
            self._json(404, {"error": "not_found"})

        def do_DELETE(self):
            path = self.path.split("?", 1)[0]
            if m := re.fullmatch(r"/api/scans/([0-9a-f]+)", path):
                if self._job(m[1]):
                    runner.delete(m[1])
                    self._empty(204)
                return
            self._json(404, {"error": "not_found"})

        def _start_scan(self):
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = -1
            if length < 0 or length > MAX_BODY:
                self.close_connection = True  # the body stays unread
                if length < 0:
                    return self._json(400, {"error": "invalid", "message": "invalid Content-Length"})
                return self._json(413, {"error": "too_large", "message": f"request body over {MAX_BODY} bytes"})
            try:
                body = json.loads(self.rfile.read(length) or b"null")
                params = _parse_params(body)
            except (ValueError, TypeError, json.JSONDecodeError) as e:
                return self._json(400, {"error": "invalid", "message": str(e) or "invalid request"})
            if status().get("printer") == "off":
                return self._json(503, {"error": "printer_off", "message": "Printer is off or not connected"})
            try:
                job = runner.start(params)
            except Busy:
                return self._json(409, {"error": "busy", "message": "Scanner is busy"})
            except PrinterOff:
                return self._json(503, {"error": "printer_off", "message": "Printer is off or not connected"})
            self._json(202, {"id": job.id})

        def _status_events(self):
            q = hub.subscribe()
            try:
                self._sse_start()
                self._sse("status", status())
                while True:
                    try:
                        event, data = q.get(timeout=PING_S)
                        self._sse(event, data)
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                hub.unsubscribe(q)

        def _job_events(self, job: Job):
            q = job.subscribe()
            try:
                self._sse_start()
                while True:
                    try:
                        event, data = q.get(timeout=PING_S)
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                        continue
                    if event == "page":
                        self._sse("page", _page_json(data))
                    else:
                        self._sse("done", _result_json(data))
                        break
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                job.unsubscribe(q)

        def _page(self, job: Job, n: int):
            page = next((p for p in job.pages if p.n == n), None)
            if page is None or not os.path.exists(page.path):
                return self._json(404, {"error": "not_found"})
            use_gzip = accepts_gzip(self.headers.get("Accept-Encoding"))
            try:
                self._send_page(page, use_gzip)
            except (ConnectionError, TimeoutError) as e:  # client went away mid-download
                log.info("page download %s/%d aborted by the client (%s)", job.id, n, type(e).__name__)
                self.close_connection = True

        def _send_page(self, page, use_gzip: bool):
            self.send_response(200)
            self.send_header("Content-Type", "image/x-portable-anymap")
            self._cors()
            if use_gzip:
                # Stream-compress (the Pi can't hold a 600 dpi colour page twice in memory);
                # no Content-Length, the response ends when the connection closes.
                self.send_header("Content-Encoding", "gzip")
                self.send_header("Connection", "close")
                self.end_headers()
                z = zlib.compressobj(1, zlib.DEFLATED, 31)
                with open(page.path, "rb") as f:
                    while chunk := f.read(1 << 20):
                        self.wfile.write(z.compress(chunk))
                self.wfile.write(z.flush())
                self.close_connection = True
            else:
                self.send_header("Content-Length", str(page.bytes))
                self.end_headers()
                with open(page.path, "rb") as f:
                    while chunk := f.read(1 << 20):
                        self.wfile.write(chunk)

    return _Server((host, port), Handler)
