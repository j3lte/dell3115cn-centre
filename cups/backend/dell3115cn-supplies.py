#!/usr/bin/env python3
"""Read Dell 3115cn supply levels over USB and print them as CUPS marker attributes.

The printer reports no supplies over PJL or PostScript, but its IEEE 1284 device ID contains a
base64 status record (STS:). Dell's Windows language monitor (dlxbazil.dll, decompiled) reads
the levels from it; see docs/PRINTER.md "Supply levels". The layout used here is checked against the printer's own
web page and SNMP: four toners, the belt unit and the fuser.

Prints e.g. `ATTR: marker-names=... marker-levels=80,80,80,40,30,40 ...` lines; a CUPS backend
wrapper forwards them to cupsd, which shows them as supply levels on clients (macOS, iOS).

Usage: dell3115cn-supplies.py [--device /dev/usb/lp0] [--order C,M,Y,K] [--debug]
"""
import argparse
import base64
import fcntl
import os
import re
import select
import subprocess
import sys
import time

DEVICE = "/dev/usb/lp0"
UEL = b"\x1b%-12345X"
ORDER = os.environ.get("DELL3115_TONER_ORDER", "C,M,Y,K")  # toner record order; verify on the printer panel
# Colour keywords, not #RRGGBB: CUPS copies marker-colors into printer-supply's colorantname, which IPP clients
# (macOS Supply Levels) expect to be a PWG colour name.
NAMES = {"C": ("Cyan Toner", "cyan"), "M": ("Magenta Toner", "magenta"),
         "Y": ("Yellow Toner", "yellow"), "K": ("Black Toner", "black")}
TONER_OFFSETS = (0x0C, 0x0E, 0x10, 0x12)   # level in percent; 0x7f (or anything over 100) = unknown
UNITS = ((0x14, "Belt Unit", "transfer-unit"), (0x16, "Fuser", "fuser"))


def device_id(dev: str) -> str:
    """Fresh IEEE 1284 device ID via LPIOC_GET_DEVICE_ID (usblp), falling back to sysfs."""
    size = 1024
    req = (2 << 30) | (size << 16) | (ord("P") << 8) | 1  # _IOC(_IOC_READ, 'P', 1, size)
    try:
        fd = os.open(dev, os.O_RDONLY | os.O_NONBLOCK)
        try:
            buf = bytearray(size)
            fcntl.ioctl(fd, req, buf)
        finally:
            os.close(fd)
        n = int.from_bytes(buf[:2], "big")
        return bytes(buf[2:n]).decode("latin1")
    except OSError:
        name = os.path.basename(dev)
        with open(f"/sys/class/usbmisc/{name}/device/ieee1284_id", encoding="latin1") as f:
            return f.read()


def parse_sts(dev_id: str) -> bytes:
    for field in dev_id.split(";"):
        key, _, value = field.strip().partition(":")
        if key == "STS":
            s = "".join(value.split())
            return base64.b64decode(s + "=" * (-len(s) % 4))
    raise ValueError("no STS field in the device ID")


def _percent(sts: bytes, off: int) -> int:
    return sts[off] if off < len(sts) and sts[off] <= 100 else -1


def levels(sts: bytes, order: str) -> list[tuple[str, str, str, int]]:
    """[(name, colour, type, percent or -1 unknown)]: four toners in `order`, then the belt unit and the fuser."""
    out = []
    for key, off in zip(order.split(","), TONER_OFFSETS):
        name, colour = NAMES[key.strip().upper()]
        out.append((name, colour, "toner", _percent(sts, off)))
    for off, name, kind in UNITS:
        out.append((name, "none", kind, _percent(sts, off)))
    return out


# printer-state-reasons this script manages (set when active, cleared otherwise).
REASONS = ("door-open-error", "cover-open-error", "other-error", "input-tray-missing-warning", "media-empty-warning",
           "toner-low-warning", "marker-supply-low-warning")
# The printer's own error codes (bytes 5-7: XXX, then YYY big-endian) seen on this model.
ERRORS = {
    (77, 300): ("door-open-error", "Front cover is open"),
    (5, 301): ("cover-open-error", "ADF top cover is open"),
    (5, 302): ("cover-open-error", "Scanner cover is open"),
}
LOW = 10  # percent, also sent as marker-low-levels


def alerts(sts: bytes) -> list[tuple[str, str]]:
    """[(printer-state-reason, text)] from the status record; empty when all is well.

    The record is only current while the print engine is awake (it sleeps in deep power saver, keeping the last state).
    """
    out = []
    if len(sts) > 7 and sts[5] != 0xFF:
        code = (sts[5], int.from_bytes(sts[6:8], "big"))
        label = f"{code[0]:03d}-{code[1]:03d}"
        reason, text = ERRORS.get(code, ("other-error", "Printer error"))
        out.append((reason, f"{text} ({label})" if code in ERRORS else f"{text} {label}"))
    if len(sts) > 0x1E:
        trays = sts[0x1E]
        if not trays & 0x20:
            out.append(("input-tray-missing-warning", "Tray 1 is not inserted"))
        elif not trays & 0x10:
            out.append(("media-empty-warning", "Tray 1 is out of paper"))
    for name, _, kind, level in levels(sts, "C,M,Y,K"):
        if 0 <= level <= LOW:
            out.append(("toner-low-warning" if kind == "toner" else "marker-supply-low-warning", f"{name} low ({level} %)"))
    return out


def state_lines(active: list[tuple[str, str]]) -> list[str]:
    """CUPS backend lines: add the active reasons and clear our other ones. The texts go into printer-alert-description,
    which CUPS keeps after the job (it clears the INFO message then), and into INFO for the job itself."""
    on = list(dict.fromkeys(r for r, _ in active))
    off = [r for r in REASONS if r not in on]
    text = "; ".join(t for _, t in active).replace('"', "'")
    lines = [f"STATE: +{','.join(on)}"] if on else []
    if off:
        lines.append(f"STATE: -{','.join(off)}")
    lines.append(f'ATTR: printer-alert-description="{text}"')
    if active:
        lines.append(f"INFO: {text}")
    return lines


def parse_pagecount(reply: str) -> int | None:
    m = re.search(r"PageCount=(\d+)", reply)
    return int(m.group(1)) if m else None


def pagecount(dev: str, timeout: float = 8.0) -> int | None:
    """Lifetime page count, asked from the PostScript interpreter over the printer interface (prints nothing).

    Only call this while no job can use the device: from the backend wrapper after a job or for a supply refresh.
    """
    ps = b"%!\n(PageCount=) print currentsystemparams /PageCount get == flush\n"
    job = UEL + b"@PJL ENTER LANGUAGE=POSTSCRIPT\r\n" + ps + b"\x04" + UEL
    fd = os.open(dev, os.O_RDWR | os.O_NONBLOCK)
    try:
        os.write(fd, job)
        buf, end = b"", time.monotonic() + timeout
        while time.monotonic() < end and b"\n" not in buf.split(b"PageCount=", 1)[-1]:
            ready, _, _ = select.select([fd], [], [], 0.3)
            if ready:
                try:
                    buf += os.read(fd, 4096)
                except BlockingIOError:
                    pass
        return parse_pagecount(buf.decode("latin1"))
    finally:
        os.close(fd)


ASLEEP = 0x13  # status byte 2 while the print engine sleeps (deep power saver): covers and trays are not sensed


def fresh_record(read_sts, query_pages, sleep=time.sleep, tries: int = 10) -> tuple[bytes, int | None]:
    """(status record, page count) with the engine awake, so covers and trays are current.

    The PostScript page-count query wakes the engine without printing (a PJL status query or an empty job does not);
    then the record is read until it no longer says asleep, at most `tries` times a second apart.
    """
    try:
        pages = query_pages()
    except OSError as e:
        print(f"DEBUG: dell3115cn-supplies: page count: {e}", file=sys.stderr)
        pages = None
    sts = read_sts()
    for _ in range(tries - 1):
        if len(sts) < 3 or sts[2] != ASLEEP:
            break
        sleep(1)
        sts = read_sts()
    return sts, pages


def names_known(queue: str | None) -> bool:
    """True if cupsd already has printer-supply-description for the queue.

    Works around a CUPS 2.4.2 bug: every "ATTR: marker-names=" from a backend appends another
    printer-supply-description attribute instead of replacing it; clients (macOS Supply Levels)
    then reject the duplicated attribute. So marker-names is only sent when it is missing.
    """
    if not queue:
        return False
    try:
        out = subprocess.run(["ipptool", "-tv", f"ipp://localhost/printers/{queue}", "get-printer-attributes.test"],
                             capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return "printer-supply-description (" in out


def attr_lines(items, send_names: bool = True, pages: int | None = None) -> list[str]:
    names = ["ATTR: marker-names=" + ",".join(f'"{n}"' for n, _, _, _ in items)] if send_names else []
    message = [f'ATTR: marker-message="{pages} pages printed"'] if pages is not None else []
    return names + message + [
        "ATTR: marker-colors=" + ",".join(c for _, c, _, _ in items),
        "ATTR: marker-types=" + ",".join(t for _, _, t, _ in items),
        "ATTR: marker-levels=" + ",".join(str(v) for _, _, _, v in items),
        "ATTR: marker-low-levels=" + ",".join(str(LOW) for _ in items),
        "ATTR: marker-high-levels=" + ",".join("100" for _ in items),
    ]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default=DEVICE)
    ap.add_argument("--order", default=ORDER)
    ap.add_argument("--debug", action="store_true")
    ap.add_argument("--pagecount", action="store_true",
                    help="also read the page count, which wakes the engine first (only when no job is running)")
    a = ap.parse_args()
    read = lambda: parse_sts(device_id(a.device))  # noqa: E731
    try:
        sts, pages = fresh_record(read, lambda: pagecount(a.device)) if a.pagecount else (read(), None)
    except (OSError, ValueError) as e:
        print(f"DEBUG: dell3115cn-supplies: {e}", file=sys.stderr)
        return 1
    if a.debug:
        print(sts.hex(" "), file=sys.stderr)
    send_names = not names_known(os.environ.get("PRINTER"))
    for line in attr_lines(levels(sts, a.order), send_names, pages) + state_lines(alerts(sts)):
        print(line, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
