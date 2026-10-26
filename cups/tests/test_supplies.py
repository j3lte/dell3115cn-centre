"""Tests for dell3115cn-supplies.py (supply levels from the STS record of the USB device ID).

Run: uv run --with pytest pytest cups/tests
"""

import importlib.util
from pathlib import Path

CUPS = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("supplies", CUPS / "backend" / "dell3115cn-supplies.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

# A real decoded record. The printer's own web page and SNMP showed at the same time: cyan, magenta, yellow 80 %,
# black 40 %, belt unit 30 %, fuser 40 %.
STS = bytes.fromhex(
    "00 00 13 04 00 ff 00 ff 00 04 00 01 50 03 50 03 50 03 28 03 1e 03 28 33 60 1a 00 00 00 00 b0 82 00 00 00 00"
    "00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 21 02 00 21 00 00 00 00 00 00 10 0c"
)


def test_levels_match_the_printers_own_report():
    assert mod.levels(STS, "C,M,Y,K") == [
        ("Cyan Toner", "cyan", "toner", 80),
        ("Magenta Toner", "magenta", "toner", 80),
        ("Yellow Toner", "yellow", "toner", 80),
        ("Black Toner", "black", "toner", 40),
        ("Belt Unit", "none", "transfer-unit", 30),
        ("Fuser", "none", "fuser", 40),
    ]


def test_unknown_level_is_minus_one():
    sts = bytearray(STS)
    sts[0x12] = 0x7F  # Dell's "unknown"
    assert mod.levels(bytes(sts), "C,M,Y,K")[3][3] == -1


def test_a_short_record_reports_unknown():
    assert [v for *_, v in mod.levels(STS[:0x10], "C,M,Y,K")] == [80, 80, -1, -1, -1, -1]


def test_toner_order_option_reorders_the_four_toners_only():
    names = [n for n, *_ in mod.levels(STS, "K,C,M,Y")]
    assert names == ["Black Toner", "Cyan Toner", "Magenta Toner", "Yellow Toner", "Belt Unit", "Fuser"]


# Records captured while changing one thing at a time; the printer's own alerts (SNMP) in the comments.
REC = {
    "ready": "00 00 19 01 00 ff 00 ff 00 04 00 01 50 03 50 03 50 03 28 03 1e 03 28 33 60 1a 00 00 00 00 b0 82",
    "front_cover": "00 00 10 00 00 4d 01 2c 00 04 00 00 7f 03 7f 03 7f 03 7f 03 7f 03 7f 33 60 1a 00 00 00 00 b0 82",  # 077-300
    "tray1_out": "00 00 19 01 00 ff 00 ff 00 04 00 01 50 03 50 03 50 03 28 03 1e 03 28 33 60 1a 00 00 00 00 80 82",  # Tray not recognized
    "tray1_empty": "00 00 19 01 00 ff 00 ff 00 04 00 01 50 03 50 03 50 03 28 03 1e 03 28 33 60 1a 00 00 00 00 a0 82",  # Out of Paper
    "adf_cover": "00 00 16 01 00 05 01 2d 00 04 00 01 50 03 50 03 50 03 28 03 1e 03 28 33 60 1a 00 00 00 00 b0 82",  # 005-301
    "scanner_lid": "00 00 16 03 00 05 01 2e 00 04 00 01 50 03 50 03 50 03 28 03 1e 03 28 33 60 1a 00 00 00 00 b0 82",  # 005-302
}


def rec(name: str) -> bytes:
    return bytes.fromhex(REC[name] + " 00" * 40)


def test_no_alerts_when_ready():
    assert mod.alerts(rec("ready")) == []
    assert mod.alerts(STS) == []


def test_cover_alerts_carry_the_printers_error_code():
    assert mod.alerts(rec("front_cover")) == [("door-open-error", "Front cover is open (077-300)")]
    assert mod.alerts(rec("adf_cover")) == [("cover-open-error", "ADF top cover is open (005-301)")]
    assert mod.alerts(rec("scanner_lid")) == [("cover-open-error", "Scanner cover is open (005-302)")]


def test_unknown_error_code_is_reported_as_is():
    sts = bytearray(rec("ready"))
    sts[5:8] = bytes([0x10, 0x00, 0x7B])  # 016-123
    assert mod.alerts(bytes(sts)) == [("other-error", "Printer error 016-123")]


def test_tray_alerts():
    assert mod.alerts(rec("tray1_out")) == [("input-tray-missing-warning", "Tray 1 is not inserted")]
    assert mod.alerts(rec("tray1_empty")) == [("media-empty-warning", "Tray 1 is out of paper")]


def test_low_supplies():
    sts = bytearray(rec("ready"))
    sts[0x12] = 8  # black toner
    sts[0x16] = 5  # fuser
    assert mod.alerts(bytes(sts)) == [
        ("toner-low-warning", "Black Toner low (8 %)"),
        ("marker-supply-low-warning", "Fuser low (5 %)"),
    ]


def test_state_lines_set_ours_and_clear_the_rest():
    lines = mod.state_lines([("media-empty-warning", "Tray 1 is out of paper")])
    assert lines[0] == "STATE: +media-empty-warning"
    assert lines[1].startswith("STATE: -") and "media-empty-warning" not in lines[1]
    assert set(lines[1][len("STATE: -"):].split(",")) == set(mod.REASONS) - {"media-empty-warning"}
    assert lines[2] == 'ATTR: printer-alert-description="Tray 1 is out of paper"'  # kept after the job, unlike INFO
    assert lines[3] == "INFO: Tray 1 is out of paper"


def test_state_lines_without_alerts_clear_everything():
    assert mod.state_lines([]) == ["STATE: -" + ",".join(mod.REASONS), 'ATTR: printer-alert-description=""']


def test_alert_texts_are_joined():
    lines = mod.state_lines([("door-open-error", "Front cover is open (077-300)"), ("media-empty-warning", "Tray 1 is out of paper")])
    assert 'ATTR: printer-alert-description="Front cover is open (077-300); Tray 1 is out of paper"' in lines


def test_parse_pagecount():
    assert mod.parse_pagecount("PageCount=66098\n") == 66098
    assert mod.parse_pagecount("%%[ Error: undefined ]%%") is None


def test_page_count_goes_into_marker_message():
    lines = mod.attr_lines(mod.levels(STS, "C,M,Y,K"), send_names=False, pages=66098)
    assert 'ATTR: marker-message="66098 pages printed"' in lines
    assert not any("marker-message" in l for l in mod.attr_lines(mod.levels(STS, "C,M,Y,K"), send_names=False))


def test_fresh_record_wakes_the_engine_first_and_waits_until_it_is_awake():
    calls = []
    asleep, awake = rec("ready"), rec("tray1_out")
    asleep = asleep[:2] + bytes([0x13, 0x04]) + asleep[4:]
    records = iter([asleep, asleep, awake])

    def read():
        calls.append("read")
        return next(records)

    def pages():
        calls.append("pages")
        return 66098

    sts, count = mod.fresh_record(read, pages, sleep=lambda s: calls.append("sleep"))
    assert (sts, count) == (awake, 66098)
    assert calls == ["pages", "read", "sleep", "read", "sleep", "read"]


def test_fresh_record_gives_up_waiting_and_survives_a_failed_query():
    asleep = rec("ready")[:2] + bytes([0x13, 0x03]) + rec("ready")[4:]

    def broken():
        raise OSError("busy")

    sts, count = mod.fresh_record(lambda: asleep, broken, sleep=lambda s: None, tries=3)
    assert (sts, count) == (asleep, None)
