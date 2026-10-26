import time

import pytest

from scan3115.device import DeviceManager
from scan3115.protocol import PrinterOff
from scan3115.sim import SimulatedDevice


def wait_for(cond, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.01)
    return False


def manager(opener):
    changes = []
    dm = DeviceManager(opener, on_change=lambda: changes.append(dm.state), poll_s=0.02)
    dm.start()
    return dm, changes


def test_goes_idle_when_device_appears():
    sim = SimulatedDevice(adf_pages=1)
    calls = []

    def opener():
        calls.append(1)
        return sim if len(calls) >= 3 else None

    dm, changes = manager(opener)
    try:
        assert dm.state == "off" or wait_for(lambda: dm.state == "idle")
        assert wait_for(lambda: dm.state == "idle")
        assert dm.paper_in_feeder is True
        assert "idle" in changes
    finally:
        dm.stop()


def test_usb_error_inside_acquire_goes_off():
    devices = [SimulatedDevice()]
    dm, changes = manager(lambda: devices[0])
    try:
        assert wait_for(lambda: dm.state == "idle")
        devices[0] = None  # unplugged: opener finds nothing from now on
        with pytest.raises(OSError):
            with dm.acquire():
                raise OSError(19, "No such device")
        assert dm.state == "off" and changes[-1] == "off"
        with pytest.raises(PrinterOff):
            with dm.acquire():
                pass
        devices[0] = SimulatedDevice()
        assert wait_for(lambda: dm.state == "idle")
    finally:
        dm.stop()


def test_jam_state_reported():
    sim = SimulatedDevice()
    sim.jammed = True
    dm, _ = manager(lambda: sim)
    try:
        assert wait_for(lambda: dm.state == "jammed")
        sim.clear_jam()
        assert wait_for(lambda: dm.state == "idle")
    finally:
        dm.stop()


def test_scanning_state_while_acquired():
    dm, changes = manager(lambda: SimulatedDevice())
    try:
        assert wait_for(lambda: dm.state == "idle")
        with dm.acquire() as s:
            assert dm.state == "scanning"
            s.test_unit_ready()
        assert dm.state == "idle"
    finally:
        dm.stop()


from scan3115.device import parse_button_events


def test_parse_button_events_application_formats():
    press = bytes.fromhex("0030000000000004")
    assert parse_button_events([press, bytes.fromhex("01000003")]) == [{"button": 1, "target": "application", "format": "tiff"}]
    assert parse_button_events([press, bytes.fromhex("01000001")]) == [{"button": 1, "target": "application", "format": "jpeg"}]
    assert parse_button_events([press, bytes.fromhex("01000004")]) == [{"button": 1, "target": "application", "format": "pdf"}]


def test_parse_button_events_ignores_noise():
    assert parse_button_events([bytes.fromhex("01000003")]) == []
    assert parse_button_events([bytes.fromhex("0030000000000004")]) == []


def test_button_event_published():
    events = [bytes.fromhex("0030000000000004"), bytes.fromhex("01000004")]

    class WithButton(SimulatedDevice):
        def read_interrupt(self, size, timeout_ms):
            if events:
                return events.pop(0)
            raise TimeoutError

    published = []
    sim = WithButton()
    dm = DeviceManager(lambda: sim, poll_s=0.02, on_button=published.append)
    dm.start()
    try:
        assert wait_for(lambda: published)
        assert published[0] == {"button": 1, "target": "application", "format": "pdf"}
    finally:
        dm.stop()


def test_interrupt_timeout_exceeds_polling_interval():
    # EP 0x85 has bInterval 11 at high speed: polled every 2**10 * 125 us = 128 ms.
    from scan3115.device import INT_TIMEOUT_MS
    assert INT_TIMEOUT_MS >= 2 * 128
