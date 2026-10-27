import logging
import re

import pytest

from scan3115.logsetup import setup_logging

LINE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (INFO |WARN |DEBUG|ERROR) scan3115\.x: (.*)$")


def test_plain_lines_on_stdout(capsys):
    setup_logging({})
    log = logging.getLogger("scan3115.x")
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
    logging.getLogger("scan3115.x").debug("shown")
    assert capsys.readouterr().out.endswith("DEBUG scan3115.x: shown\n")


def test_unknown_level():
    with pytest.raises(SystemExit, match="LOG_LEVEL must be debug, info, warn or error: loud"):
        setup_logging({"LOG_LEVEL": "loud"})


def test_old_variable_still_works(capsys):
    setup_logging({"SCAN3115_LOG": "debug"})
    logging.getLogger("scan3115.x").debug("shown")
    assert capsys.readouterr().out.endswith("DEBUG scan3115.x: shown\n")


def test_log_level_wins_over_the_old_variable(capsys):
    setup_logging({"SCAN3115_LOG": "debug", "LOG_LEVEL": "info"})
    logging.getLogger("scan3115.x").debug("hidden")
    assert capsys.readouterr().out == ""
