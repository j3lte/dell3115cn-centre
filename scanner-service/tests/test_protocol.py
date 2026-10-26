import pytest

from scan3115.protocol import FeederEmpty, PaperJam, ScanError, Scanner


def test_command_without_data_writes_8_byte_block(scripted):
    t = scripted([bytes.fromhex("0042000b00000000")])
    s = Scanner(t)
    s.command(0x42)
    assert t.writes == [bytes.fromhex("0042000000000000")]
    assert s.last_flags == 0x0b


def test_command_with_data_sends_length_then_data(scripted):
    t = scripted([bytes.fromhex("004c000b00000000")])
    Scanner(t).command(0x4c, b"\x80\x00\x00\x00")
    assert t.writes == [bytes.fromhex("004c000000000004"), b"\x80\x00\x00\x00"]


def test_status_and_data_in_one_transfer(scripted):
    # Real Inquiry response captured from the device.
    inquiry = bytes.fromhex(
        "068002021f000020" + "DELL Inc.".encode().hex() + "20" * 23
        + "DELL MFP Laser 3115".encode().hex() + "20" * 13 + "200809111016".encode().hex() + "20" * 4)
    assert len(inquiry) == 0x58
    t = scripted([bytes.fromhex("0041000000000058") + inquiry])
    info = Scanner(t).inquiry()
    assert info == {"vendor": "DELL Inc.", "product": "DELL MFP Laser 3115", "firmware": "200809111016"}


def _sense(key, asc):
    return bytes(4) + bytes([key, asc]) + bytes(26)


def test_check_condition_maps_feeder_empty_and_jam(scripted):
    t = scripted([bytes.fromhex("0044022b00000020") + _sense(0x02, 0x3a)])
    with pytest.raises(FeederEmpty):
        Scanner(t).command(0x44, bytes(0x30))
    t = scripted([bytes.fromhex("004902ee00000020") + _sense(0x02, 0x53)])
    with pytest.raises(PaperJam):
        Scanner(t).command(0x49, b"\x00\x01\x00\x00", expect_data=True)


def test_busy_status_retries_after_sleep(scripted):
    t = scripted([bytes.fromhex("0042080000000000"), bytes.fromhex("0042000b00000000")])
    slept = []
    Scanner(t, sleep=slept.append).command(0x42)
    assert slept == [1.0] and len(t.writes) == 2


def test_echo_mismatch_raises(scripted):
    t = scripted([bytes.fromhex("0043000000000000")])
    with pytest.raises(ScanError):
        Scanner(t).command(0x42)


def test_data_split_over_several_transfers(scripted):
    t = scripted([bytes.fromhex("0049000d00000400") + bytes(504), bytes(520)])
    assert len(Scanner(t).command(0x49, b"\x00\x00\x04\x00", expect_data=True)) == 0x400
