"""Plain-text log lines on stdout, like the web app's: `<UTC time> <LEVEL> <logger>: <message>`."""

import logging
import sys
import time

LEVELS = {"debug": logging.DEBUG, "info": logging.INFO, "warn": logging.WARNING, "warning": logging.WARNING,
          "error": logging.ERROR}


class _UtcFormatter(logging.Formatter):
    def formatTime(self, record, datefmt=None):  # noqa: N802 (logging API)
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + f".{int(record.msecs):03d}Z"


def setup_logging(env) -> None:
    """LOG_LEVEL (or the older SCAN3115_LOG): debug, info (default), warn or error."""
    value = env.get("LOG_LEVEL") or env.get("SCAN3115_LOG") or "info"
    level = LEVELS.get(value.strip().lower())
    if level is None:
        raise SystemExit(f"LOG_LEVEL must be debug, info, warn or error: {value}")
    logging.addLevelName(logging.WARNING, "WARN")
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(_UtcFormatter("%(asctime)s %(levelname)-5s %(name)s: %(message)s"))
    logging.basicConfig(level=level, handlers=[handler], force=True)
