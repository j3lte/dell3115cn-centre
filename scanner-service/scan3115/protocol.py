"""Dell MFP Laser 3115cn scan protocol over a byte transport.

See docs/PROTOCOL.md. Every command is one transaction: an 8-byte command block,
an optional OUT data phase, an 8-byte status block, and an optional IN data
phase. The device sends the status block and the IN data in the same bulk
transfer, so reads always go through a buffer.
"""

import dataclasses
import math
import struct
import time
from typing import Callable, Iterator, Literal, Protocol

BUSY_RETRIES = 40
ST_GOOD, ST_CHECK, ST_RESERVATION = 0x00, 0x02, 0x18
ST_BUSY = (0x08, 0x09)

CMD_NAMES = {
    0x40: "Reserve Unit", 0x41: "Inquiry", 0x42: "Test Unit Ready", 0x43: "Mode Sense",
    0x44: "Mode Select", 0x45: "Set Window", 0x46: "Get Window", 0x47: "Send", 0x48: "Scan",
    0x49: "Read", 0x4A: "Release Unit", 0x4C: "Scanner Initialize", 0x4E: "Read Image Size",
    0x4F: "Wake up",
}


class Transport(Protocol):
    def write(self, data: bytes) -> None: ...

    def read(self, size: int) -> bytes:
        """Read up to `size` bytes (a multiple of 512). Raises TimeoutError on timeout."""
        ...


class ScanError(Exception):
    pass


class Busy(ScanError):
    pass


class PrinterOff(ScanError):
    pass


class SpoolError(ScanError):
    """Writing page files failed (disk full, permissions) — not a scanner problem."""


class ReservationConflict(ScanError):
    pass


class CheckCondition(ScanError):
    def __init__(self, cmd: int, sense: bytes, message: str | None = None):
        self.cmd = cmd
        self.sense = sense
        self.key = sense[4] if len(sense) > 4 else 0
        self.asc = sense[5] if len(sense) > 5 else 0
        name = CMD_NAMES.get(cmd, hex(cmd))
        super().__init__(message or f"{name}: check condition {self.key:02x}/{self.asc:02x}")

    @staticmethod
    def make(cmd: int, sense: bytes) -> "CheckCondition":
        key = sense[4] if len(sense) > 4 else 0
        asc = sense[5] if len(sense) > 5 else 0
        if (key, asc) == (0x02, 0x3A):
            return FeederEmpty(cmd, sense, "No paper in the feeder")
        if (key, asc) == (0x02, 0x53):
            return PaperJam(cmd, sense, "Paper jam — open and close the ADF cover")
        return CheckCondition(cmd, sense)


class FeederEmpty(CheckCondition):
    pass


class PaperJam(CheckCondition):
    pass


class Scanner:
    def __init__(self, transport: Transport, sleep: Callable[[float], None] = time.sleep):
        self.t = transport
        self.sleep = sleep
        self.rx = bytearray()
        self.last_flags = 0
        self.on_flags: Callable[[int], None] | None = None  # called with status byte 3 of every status block

    def _read_exact(self, n: int) -> bytes:
        while len(self.rx) < n:
            want = max(512, (n - len(self.rx) + 511) // 512 * 512)
            self.rx += self.t.read(min(want, 0x80000))
        out = bytes(self.rx[:n])
        del self.rx[:n]
        return out

    def command(self, cmd: int, data: bytes = b"", expect_data: bool = False) -> bytes:
        name = CMD_NAMES.get(cmd, hex(cmd))
        for _ in range(BUSY_RETRIES + 1):
            self.t.write(struct.pack(">BBxxI", 0, cmd, len(data)))
            if data:
                self.t.write(data)
            status = self._read_exact(8)
            client, echo, st, flags = status[0], status[1], status[2], status[3]
            length = struct.unpack(">I", status[4:8])[0]
            if client != 0 or echo != cmd:
                self.rx.clear()
                raise ScanError(f"{name}: bad status block {status.hex(' ')}")
            self.last_flags = flags
            if self.on_flags is not None:
                self.on_flags(flags)
            if st == ST_CHECK:
                raise CheckCondition.make(cmd, self._read_exact(length) if length else b"")
            if st in ST_BUSY:
                self.sleep(1.0)
                continue
            if st == ST_RESERVATION:
                raise ReservationConflict(f"{name}: reservation conflict")
            # Good, or an unknown status the Windows driver also treats as good.
            return self._read_exact(length) if expect_data and length else b""
        raise Busy(f"{name}: busy time-out")

    @property
    def paper_in_feeder(self) -> bool:
        return bool(self.last_flags & 0x40)

    def inquiry(self) -> dict:
        d = self.command(0x41, expect_data=True)
        return {
            "vendor": d[0x08:0x28].decode("ascii", "replace").strip(),
            "product": d[0x28:0x48].decode("ascii", "replace").strip(),
            "firmware": d[0x48:0x58].decode("ascii", "replace").strip(),
        }

    def mode_sense(self) -> bytes:
        return self.command(0x43, expect_data=True)

    def test_unit_ready(self) -> None:
        self.command(0x42)

    def reserve(self) -> None:
        self.command(0x40)

    def release(self) -> None:
        self.command(0x4A)

    def initialize(self, abort: bool = False) -> None:
        self.command(0x4C, bytes([0x80 if abort else 0x00, 0, 0, 0]))


# --- Scan parameters, geometry and the single-page sequence ------------------------------


DPIS = (75, 100, 150, 200, 300, 400, 600)
MODES = {"lineart": (0x00, 1, None), "gray": (0x02, 8, 1), "color": (0x05, 8, 3)}  # composition, depth, bytes/px
# 16 bits per channel: colour only (16-bit gray returns garbled data on this scanner). The device sends
# line-planar little-endian samples.
DEPTHS = {"lineart": (8,), "gray": (8,), "color": (8, 16)}
PAPER_MM = {"a4": (210.0, 297.0), "letter": (215.9, 279.4), "legal": (215.9, 355.6)}
FLATBED_MILS = (8490, 11685)
ADF_MILS = (8500, 14000)
MAX_X600 = 5100
MIN_AREA_MM = 2.0


class Cancelled(ScanError):
    pass


@dataclasses.dataclass(frozen=True)
class ScanParams:
    source: Literal["flatbed", "adf"]
    mode: Literal["lineart", "gray", "color"]
    dpi: int
    area_mm: tuple[float, float, float, float] | None = None
    paper: Literal["a4", "letter", "legal"] = "a4"
    threshold: int = 0xC3
    depth: int = 8  # bits per channel for gray/colour; lineart is always 1 bit on the device

    def validate(self) -> None:
        if self.source not in ("flatbed", "adf"):
            raise ValueError(f"source must be flatbed or adf, not {self.source!r}")
        if self.mode not in MODES:
            raise ValueError(f"mode must be one of {', '.join(MODES)}, not {self.mode!r}")
        if type(self.dpi) is not int or self.dpi not in DPIS:
            raise ValueError(f"dpi must be one of {', '.join(map(str, DPIS))}, not {self.dpi!r}")
        if self.paper not in PAPER_MM:
            raise ValueError(f"paper must be one of {', '.join(PAPER_MM)}, not {self.paper!r}")
        if not 0 <= self.threshold <= 255:
            raise ValueError("threshold must be 0-255")
        if type(self.depth) is not int or self.depth not in DEPTHS[self.mode]:
            raise ValueError(f"depth must be one of {', '.join(map(str, DEPTHS[self.mode]))} "
                             f"for {self.mode}, not {self.depth!r}")
        if self.area_mm is not None:
            if len(self.area_mm) != 4:
                raise ValueError("area_mm must be [x, y, width, height]")
            if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in self.area_mm):
                raise ValueError("area_mm values must be finite numbers")
            x, y, w, h = self.area_mm
            if x < 0 or y < 0 or w < MIN_AREA_MM or h < MIN_AREA_MM:
                raise ValueError(f"area_mm must have x, y >= 0 and width, height >= {MIN_AREA_MM} mm")
            mils = FLATBED_MILS if self.source == "flatbed" else ADF_MILS
            max_w, max_h = mils[0] * 0.0254, mils[1] * 0.0254
            if x + w > max_w + 0.01 or y + h > max_h + 0.01:
                raise ValueError(f"area_mm exceeds the scan area ({max_w:.1f} x {max_h:.1f} mm)")


@dataclasses.dataclass(frozen=True)
class Geometry:
    x600: int
    y600: int
    w600: int
    h600: int
    width: int       # output pixels per line
    lines: int       # output lines
    px: int          # padded device line width in pixels
    line_bytes: int  # raw bytes per device line


def _mm_to_px(mm: float, dpi: int) -> int:
    return round(mm * dpi / 25.4)


def compute_geometry(p: ScanParams) -> Geometry:
    dpi = p.dpi
    if p.area_mm is not None:
        x, y, w, h = (_mm_to_px(v, dpi) for v in p.area_mm)
    elif p.source == "flatbed":
        x, y, w, h = 0, 0, FLATBED_MILS[0] * dpi // 1000, FLATBED_MILS[1] * dpi // 1000
    else:
        pw, ph = PAPER_MM[p.paper]
        x, y, w, h = 0, 0, _mm_to_px(pw, dpi), _mm_to_px(ph, dpi)

    x600 = x * 600 // dpi
    y600 = y * 600 // dpi
    w600 = (w * 600 // dpi + 31) & ~31
    if x600 + w600 > MAX_X600:
        over = x600 + w600 - MAX_X600
        x600 = max(0, x600 - over)
        if x600 + w600 > MAX_X600:
            w600 = MAX_X600 - x600
    h600 = int(h * 600 / dpi + 0.5)

    px = ((w600 * dpi // 600) + 31) & ~31
    bpp = MODES[p.mode][2]
    line_bytes = px // 8 if bpp is None else px * bpp * p.depth // 8
    return Geometry(x600, y600, w600, h600, min(w, px), h, px, line_bytes)


def build_window(p: ScanParams, g: Geometry) -> bytes:
    composition, depth, _ = MODES[p.mode]
    win = bytearray(0x30)
    struct.pack_into(">HH", win, 0x02, p.dpi, p.dpi)
    # The Windows driver's scratch copy of the area lives inside the window buffer,
    # so the device expects it twice: at 0x08 and at 0x20.
    struct.pack_into(">IIII", win, 0x08, g.x600, g.y600, g.w600, g.h600)
    struct.pack_into(">IIII", win, 0x20, g.x600, g.y600, g.w600, g.h600)
    win[0x19] = p.threshold if depth == 1 else 0
    win[0x1A] = composition
    win[0x1B] = depth if depth == 1 else p.depth
    win[0x1D] = 0x36 if p.source == "adf" else 0x32
    return bytes(win)


def scan_page(s: Scanner, p: ScanParams, read_bytes: int,
              should_cancel: Callable[[], bool] = lambda: False) -> Iterator[bytes]:
    """Scan one page and yield raw device lines, top to bottom.

    Always ends with Initialize + Release Unit, also on errors, cancel and early close.
    """
    g = compute_geometry(p)
    s.reserve()
    try:
        s.test_unit_ready()
        s.initialize()
        s.command(0x44, bytes([0x03, 0x06, 0x00, 0x00, 0x02, 0x58, 0x00, 0x00]))
        page20 = bytearray(0x30)
        page20[0], page20[1], page20[2] = 0x20, 0x2E, 0x40 if p.source == "adf" else 0x00
        s.command(0x44, bytes(page20))
        s.command(0x45, build_window(p, g))
        s.command(0x48)

        lines_left = g.lines
        lines_per_read = max(1, read_bytes // g.line_bytes)
        while lines_left > 0:
            if should_cancel():
                raise Cancelled("Scan cancelled")
            n = min(lines_per_read, lines_left)
            data = s.command(0x49, struct.pack(">I", n * g.line_bytes), expect_data=True)
            got = len(data) // g.line_bytes
            for i in range(got):
                yield data[i * g.line_bytes:(i + 1) * g.line_bytes]
            lines_left -= got
            if got < n:
                break  # page ended before the window did (short page)
        s.initialize()
    except BaseException:
        try:
            s.initialize(abort=True)
        except Exception:
            pass
        raise
    finally:
        try:
            s.release()
        except Exception:
            pass
