"""Plain-text log lines on stdout, like the web app's: `<UTC time> <LEVEL> <logger>: <message>`."""

import logging
import sys
import time

LEVELS = {"debug": logging.DEBUG, "info": logging.INFO, "warn": logging.WARNING, "warning": logging.WARNING,
          "error": logging.ERROR,
          "critical": logging.CRITICAL}


def setup_logging(env) -> None:
    """SCAN3115_LOG or LOG_LEVEL: debug, info (default), warn, error or critical."""
    value = env.get("SCAN3115_LOG") or env.get("LOG_LEVEL") or "info"
    level = LEVELS.get(value.strip().lower())
    if level is None:
        raise SystemExit(f"LOG_LEVEL must be debug, info, warn, error or critical: {value}")
    logging.addLevelName(logging.WARNING, "WARN")
    handler = logging.StreamHandler(sys.stdout)
    fmt = logging.Formatter("%(asctime)s %(levelname)-5s %(name)s: %(message)s")
    fmt.converter = time.gmtime  # UTC, ISO 8601 with milliseconds
    fmt.default_time_format, fmt.default_msec_format = "%Y-%m-%dT%H:%M:%S", "%s.%03dZ"
    handler.setFormatter(fmt)
    logging.basicConfig(level=level, handlers=[handler], force=True)
