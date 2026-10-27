# SPDX-License-Identifier: GPL-3.0-or-later
"""HTTP API (stdlib only).

  GET  /health                 -> 200 {"ok": true, "service": "analyse", "analyses": ["deda"]}
  POST /deda/?dpi=150..1200    -> body = image bytes; 200 report | 400 invalid | 413 too_large
"""

import json
import logging
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from . import report

log = logging.getLogger(__name__)
MAX_BODY = 256 * 1024 * 1024
DEFAULT_DPI, MIN_DPI, MAX_DPI = 600, 150, 1200
# One page at a time: a 600 dpi page needs most of a GiB, and decode's warning capture is not thread-safe.
_analyse_lock = threading.Lock()
_ROUTES = {"/health": "GET", "/deda/": "POST"}


class _Invalid(Exception):
    pass


def _parse_dpi(query: str) -> int:
    values = parse_qs(query, keep_blank_values=True).get("dpi")
    if not values:
        return DEFAULT_DPI
    try:
        dpi = int(values[-1])
    except ValueError:
        raise _Invalid("dpi must be an integer") from None
    if not MIN_DPI <= dpi <= MAX_DPI:
        raise _Invalid(f"dpi must be between {MIN_DPI} and {MAX_DPI}")
    return dpi


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "analyse"
    timeout = 60  # seconds a socket read may stall: a dead client must not hold a thread (or the lock) forever

    def log_message(self, fmt, *args):  # replaced by _log: never log request content
        pass

    def _log(self, status: int, started: float) -> None:
        log.info("%s %s -> %d (%.2fs)", self.command, urlsplit(self.path).path, status, time.monotonic() - started)

    def _json(self, status: int, obj, allow: str | None = None) -> None:
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if allow:
            self.send_header("Allow", allow)
        self.end_headers()
        self.wfile.write(body)

    def _route(self, method: str):
        """Returns (path, query) when the request is for a known route and method, else answers and returns None."""
        parts = urlsplit(self.path)
        allowed = _ROUTES.get(parts.path)
        if allowed is None:
            self._json(404, {"error": "not_found"})
        elif allowed != method:
            self._json(405, {"error": "method_not_allowed"}, allow=allowed)
        else:
            return parts.path, parts.query
        return None

    def _handle(self, method: str) -> None:
        started = time.monotonic()
        status = 500
        try:
            route = self._route(method)
            if route is None:
                status = 404 if urlsplit(self.path).path not in _ROUTES else 405
            elif route[0] == "/health":
                status = 200
                self._json(200, {"ok": True, "service": "analyse", "analyses": ["deda"]})
            else:
                status = self._deda(route[1])
        except Exception:
            log.exception("unhandled error")
            self.close_connection = True
            try:
                self._json(500, {"error": "internal"})
            except OSError:
                pass  # client already gone
        finally:
            self._log(status, started)

    def _deda(self, query: str) -> int:
        try:
            dpi = _parse_dpi(query)
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                raise _Invalid("Content-Length required") from None
            if length < 0:
                raise _Invalid("Content-Length required")
        except _Invalid as e:
            self.close_connection = True  # the unread body would corrupt the next request
            self._json(400, {"error": "invalid", "message": str(e)})
            return 400
        if length > MAX_BODY:
            self.close_connection = True
            self._json(413, {"error": "too_large"})
            return 413
        if length == 0:
            self._json(400, {"error": "invalid", "message": "empty body"})
            return 400
        # Read under the lock too: at most one upload (up to MAX_BODY) is in memory at a time.
        with _analyse_lock:
            try:
                data = self.rfile.read(length)
            except OSError:  # includes the read timeout of a stalled client
                self.close_connection = True
                return 408
            if len(data) != length:
                self.close_connection = True
                self._json(400, {"error": "invalid", "message": "incomplete body"})
                return 400
            try:
                result = report.analyse(data, dpi)
            except ValueError as e:
                data = None
                self._json(400, {"error": "invalid", "message": str(e)})
                return 400
            data = None
        self._json(200, result)
        return 200

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_PUT(self):
        self._handle("PUT")

    def do_DELETE(self):
        self._handle("DELETE")

    def do_PATCH(self):
        self._handle("PATCH")


def serve(port: int) -> ThreadingHTTPServer:
    """Bind (not yet serving) on all interfaces; port 0 picks a free one."""
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    srv.daemon_threads = True
    return srv
