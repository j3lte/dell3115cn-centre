# SPDX-License-Identifier: GPL-3.0-or-later
import logging
import re

import pytest


@pytest.fixture(autouse=True)
def _restore_logging():
    """setup_logging replaces the root handlers; put pytest's back afterwards."""
    root = logging.getLogger()
    handlers, level = root.handlers[:], root.level
    yield
    root.handlers[:] = handlers
    root.setLevel(level)
    logging.addLevelName(logging.WARNING, "WARNING")

from deda_svc.logsetup import setup_logging

LINE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (INFO |WARN |DEBUG|ERROR) analyse\.x: (.*)$")


def test_plain_lines_on_stdout(capsys):
    setup_logging({})
    log = logging.getLogger("analyse.x")
    log.info("hello %d", 1)
    log.warning("careful")
    log.debug("hidden")
    out = capsys.readouterr()
    assert out.err == ""
    lines = out.out.splitlines()
    assert [LINE.match(l).group(1, 2) for l in lines] == [("INFO ", "hello 1"), ("WARN ", "careful")]


@pytest.mark.parametrize("value", ["debug", "DEBUG"])
def test_log_level(capsys, value):
    setup_logging({"LOG_LEVEL": value})
    logging.getLogger("analyse.x").debug("shown")
    assert capsys.readouterr().out.endswith("DEBUG analyse.x: shown\n")


def test_unknown_level():
    with pytest.raises(SystemExit, match="LOG_LEVEL must be debug, info, warn, error or critical: loud"):
        setup_logging({"LOG_LEVEL": "loud"})
