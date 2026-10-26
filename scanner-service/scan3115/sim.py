"""Protocol-level emulator of the Dell 3115cn scanner (USB interface 0).

Implements the Transport interface and answers commands the way the real
device does (docs/PROTOCOL.md): status block and data in one transfer, check
conditions for feeder empty and paper jam, status flags in byte 3.
Used by the tests and by SCAN3115_SIM=1 for development without hardware.
"""

import struct
import threading
import time

FLAGS_IDLE, FLAGS_PAPER, FLAGS_DATA, FLAGS_LAST = 0x0B, 0x4B, 0x4D, 0x0E
FLAGS_JAM = 0xEE
SENSE_FEEDER_EMPTY = (0x02, 0x3A)
SENSE_JAM = (0x02, 0x53)
SENSE_INVALID = (0x05, 0x26)

# Commands that carry an OUT data phase.
DATA_CMDS = {0x44, 0x45, 0x47, 0x49, 0x4C}


class SimulatedDevice:
    def __init__(self, adf_pages: int = 0, jam_at: tuple[int, int] | None = None,
                 short_page_lines: int | None = None, refill: bool = False, jam_clear_s: float | None = None):
        self.adf_pages = adf_pages
        self.refill = refill                # put the same stack back after "feeder empty" (dev mode)
        self.jam_clear_s = jam_clear_s      # auto "open and close the cover" after this many seconds
        self._initial_pages = adf_pages
        self._jam_since = 0.0
        self.jam_at = jam_at
        self.short_page_lines = short_page_lines
        self.jammed = False
        self.reserved = False
        self.lock = threading.Lock()
        self._out = bytearray()
        self._pending: tuple[int, int] | None = None  # (cmd, data length) awaiting OUT data
        self._data = bytearray()
        self._adf = False
        self._window: dict | None = None
        self._page_no = 0
        self._lines_sent = 0
        self._page_lines = 0

    # --- Transport -------------------------------------------------------------------

    def write(self, data: bytes) -> None:
        with self.lock:
            if self._pending is None:
                _, cmd, length = struct.unpack(">BBxxI", data[:8])
                if cmd in DATA_CMDS and length:
                    self._pending, self._data = (cmd, length), bytearray()
                else:
                    self._handle(cmd, b"")
                return
            self._data += data
            cmd, length = self._pending
            if len(self._data) >= length:
                self._pending = None
                self._handle(cmd, bytes(self._data[:length]))

    def read(self, size: int) -> bytes:
        with self.lock:
            if not self._out:
                raise TimeoutError("simulated device: nothing to read")
            chunk = bytes(self._out[:size])
            del self._out[:size]
            return chunk

    def clear_jam(self) -> None:
        with self.lock:
            self.jammed = False

    def drain(self) -> int:
        with self.lock:
            n = len(self._out)
            self._out.clear()
            self._pending = None
            return n

    # --- Device behaviour ------------------------------------------------------------

    def _flags(self) -> int:
        return FLAGS_PAPER if self.adf_pages > 0 else FLAGS_IDLE

    def _reply(self, cmd: int, data: bytes = b"", flags: int | None = None) -> None:
        f = self._flags() if flags is None else flags
        self._out += struct.pack(">BBBBI", 0, cmd, 0, f, len(data)) + data

    def _check(self, cmd: int, key_asc: tuple[int, int], flags: int = 0x2B) -> None:
        sense = bytes(4) + bytes(key_asc) + bytes(26)
        self._out += struct.pack(">BBBBI", 0, cmd, 2, flags, len(sense)) + sense

    def _handle(self, cmd: int, data: bytes) -> None:
        if self.jammed and self.jam_clear_s is not None and time.monotonic() - self._jam_since >= self.jam_clear_s:
            self.jammed = False
        if self.jammed and cmd != 0x41:
            self._check(cmd, SENSE_JAM, 0xA0)
            return
        if cmd == 0x40:
            self.reserved = True
            self._reply(cmd)
        elif cmd == 0x4A:
            self.reserved = False
            self._reply(cmd)
        elif cmd == 0x41:
            self._reply(cmd, self._inquiry())
        elif cmd == 0x43:
            self._reply(cmd, bytes.fromhex(  # real Mode Sense capture
                "0306000000000000" "202621ff000000000000" "27d8000036cf000027d8000041a0" "0258025802580258" "00010001"
            ).ljust(0x40, b"\0"))
        elif cmd in (0x42, 0x4C):
            self._reply(cmd)
        elif cmd == 0x44:
            if data[:1] == b"\x20":
                self._adf = bool(data[2] & 0x40)
                if self._adf and self.adf_pages <= 0:
                    self._check(cmd, SENSE_FEEDER_EMPTY)
                    if self.refill:
                        self.adf_pages = self._initial_pages
                    return
            self._reply(cmd)
        elif cmd == 0x45:
            self._window = self._parse_window(data)
            self._reply(cmd)
        elif cmd == 0x48:
            if self._window is None:
                self._check(cmd, SENSE_INVALID)
                return
            if self._adf:
                self.adf_pages -= 1
            self._page_no += 1
            self._lines_sent = 0
            self._page_lines = self._window["lines"]
            if self.short_page_lines is not None:
                self._page_lines = min(self._page_lines, self.short_page_lines)
            self._reply(cmd)
        elif cmd == 0x49:
            self._read_image(cmd, struct.unpack(">I", data[:4])[0])
        else:
            self._reply(cmd)

    def _read_image(self, cmd: int, nbytes: int) -> None:
        w = self._window
        lb = w["line_bytes"]
        want = nbytes // lb
        if self.jam_at and self._page_no == self.jam_at[0] and self._lines_sent + want > self.jam_at[1]:
            self.jammed = True
            self._jam_since = time.monotonic()
            self._check(cmd, SENSE_JAM, FLAGS_JAM)
            return
        n = min(want, self._page_lines - self._lines_sent)
        out = bytearray()
        for i in range(n):
            out += self._line(self._lines_sent + i, w)
        self._lines_sent += n
        last = self._lines_sent >= self._page_lines
        self._reply(cmd, bytes(out), FLAGS_LAST if last else FLAGS_DATA)

    def _line(self, idx: int, w: dict) -> bytes:
        px = w["px"]
        if w["depth"] == 1:
            return bytes([0xAA if idx % 2 else 0x00]) * (px // 8)
        if w["composition"] == 0x05:
            if w["depth"] == 16:  # line-planar R, G, B, little-endian samples
                return b"".join(struct.pack("<H", v) * px for v in (0x0101, 0x0202, 0x0303))
            return bytes([1]) * px + bytes([2]) * px + bytes([3]) * px  # line-planar R, G, B
        line = bytearray([(idx + self._page_no * 16) % 256]) * px
        line[0] = self._page_no % 256
        return bytes(line)

    @staticmethod
    def _parse_window(win: bytes) -> dict:
        dpi = struct.unpack(">H", win[2:4])[0]
        w600, h600 = struct.unpack(">II", win[0x10:0x18])
        px = ((w600 * dpi // 600) + 31) & ~31
        composition, depth = win[0x1A], win[0x1B]
        bpp = 3 if composition == 0x05 else 1
        line_bytes = px // 8 if depth == 1 else px * bpp * depth // 8
        return {"dpi": dpi, "px": px, "lines": round(h600 * dpi / 600), "composition": composition,
                "depth": depth, "line_bytes": line_bytes}

    @staticmethod
    def _inquiry() -> bytes:
        return (bytes.fromhex("068002021f000020") + b"DELL Inc.".ljust(32) + b"DELL MFP Laser 3115".ljust(32)
                + b"SIMULATED".ljust(16))


def sim_from_env(env) -> SimulatedDevice:
    """Simulator for SCAN3115_SIM=1: SCAN3115_SIM_PAGES (default 3, refilled after each batch),
    SCAN3115_SIM_JAM="page:line" (jam once), SCAN3115_SIM_JAM_CLEAR_S (default 5)."""
    jam = env.get("SCAN3115_SIM_JAM")
    jam_at = tuple(int(v) for v in jam.split(":", 1)) if jam else None
    return SimulatedDevice(adf_pages=int(env.get("SCAN3115_SIM_PAGES", "3")), jam_at=jam_at, refill=True,
                           jam_clear_s=float(env.get("SCAN3115_SIM_JAM_CLEAR_S", "5")))
