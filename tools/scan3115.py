#!/usr/bin/env python3
"""Prototype driver for the Dell MFP Laser 3115cn scanner (USB 413c:5607, interface 0).

Protocol: see ../docs/PROTOCOL.md. Requires pyusb and libusb-1.0.

  scan3115.py probe                 # Inquiry, Mode Sense, Test Unit Ready
  scan3115.py scan out.ppm --dpi 150 --mode color --area 0,0,1240,1754
"""

import argparse
import os
import struct
import sys
import time

import usb.core
import usb.util

VID, PID = 0x413C, 0x5607
EP_OUT, EP_IN = 0x01, 0x82
TIMEOUT_MS = 30000

CMD_NAMES = {
    0x40: "Reserve Unit", 0x41: "Inquiry", 0x42: "Test Unit Ready", 0x43: "Mode Sense",
    0x44: "Mode Select", 0x45: "Set Window", 0x46: "Get Window", 0x47: "Send", 0x48: "Scan",
    0x49: "Read", 0x4A: "Release Unit", 0x4C: "Scanner Initialize", 0x4E: "Read Image Size",
    0x4F: "Wake up",
}

ST_GOOD, ST_CHECK, ST_RESERVATION = 0x00, 0x02, 0x18
BUSY_RETRIES = 40

MODES = {
    # name: (composition, bits per channel, bytes per pixel or None for 1-bit)
    "lineart": (0x00, 1, None),
    "gray": (0x02, 8, 1),
    "color": (0x05, 8, 3),
}


class ScanError(Exception):
    pass


class CheckCondition(ScanError):
    def __init__(self, cmd, sense):
        self.sense = sense
        super().__init__(f"{CMD_NAMES.get(cmd, hex(cmd))}: check condition, sense={sense.hex(' ')}")


def hexdump(data, limit=64):
    s = data[:limit].hex(" ")
    return s + (f" ... ({len(data)} bytes)" if len(data) > limit else "")


class Scanner:
    def __init__(self, verbose=False):
        self.verbose = verbose
        self.dev = usb.core.find(idVendor=VID, idProduct=PID)
        if self.dev is None:
            raise ScanError("Dell 3115cn (413c:5607) not found")
        if self.dev.is_kernel_driver_active(0):
            self.dev.detach_kernel_driver(0)
        usb.util.claim_interface(self.dev, 0)
        self.rx = bytearray()
        self.read_bytes = int(os.environ.get("SCAN_READ_BYTES", 0x40000))

    def close(self):
        usb.util.release_interface(self.dev, 0)
        usb.util.dispose_resources(self.dev)

    def log(self, msg):
        if self.verbose:
            print(msg, file=sys.stderr)

    def _read_exact(self, n):
        # The device sends the status block and data phase in one transfer, so always
        # read whole packets into a buffer and hand out exactly n bytes from it.
        while len(self.rx) < n:
            want = max(512, (n - len(self.rx) + 511) // 512 * 512)
            chunk = self.dev.read(EP_IN, min(want, 0x80000), TIMEOUT_MS)
            if len(chunk) == 0:
                continue
            self.rx += chunk
        out = bytes(self.rx[:n])
        del self.rx[:n]
        return out

    def command(self, cmd, data=b"", expect_data=False):
        """Run one transaction. Returns the IN data phase (or b"")."""
        name = CMD_NAMES.get(cmd, hex(cmd))
        for attempt in range(BUSY_RETRIES + 1):
            block = struct.pack(">BBxxI", 0, cmd, len(data))
            self.log(f">>> {name} [{cmd:02x}] out={hexdump(data) if data else '-'}")
            self.dev.write(EP_OUT, block, TIMEOUT_MS)
            if data:
                self.dev.write(EP_OUT, data, TIMEOUT_MS)
            status = self._read_exact(8)
            client, echo, st, length = status[0], status[1], status[2], struct.unpack(">I", status[4:8])[0]
            self.log(f"<<< status {hexdump(status)}")
            if client != 0 or echo != cmd:
                raise ScanError(f"{name}: bad status block {status.hex(' ')}")
            if st == ST_GOOD:
                if expect_data and length:
                    payload = self._read_exact(length)
                    self.log(f"<<< data {hexdump(payload)}")
                    return payload
                return b""
            if st == ST_CHECK:
                sense = self._read_exact(length) if length else b""
                raise CheckCondition(cmd, sense)
            if st in (0x08, 0x09):
                self.log(f"    busy, retry {attempt + 1}/{BUSY_RETRIES}")
                time.sleep(1)
                continue
            if st == ST_RESERVATION:
                raise ScanError(f"{name}: reservation conflict")
            self.log(f"    unknown status {st:#x}, treating as good (as the Windows driver does)")
            return b""
        raise ScanError(f"{name}: busy time-out")

    # --- individual commands -------------------------------------------------

    def inquiry(self):
        # Standard SCSI INQUIRY layout: type 0x06 = scanner.
        d = self.command(0x41, expect_data=True)
        vendor = d[0x08:0x10].decode("ascii", "replace").strip()
        product = d[0x10:0x20].decode("ascii", "replace").strip()
        firmware = d[0x20:0x58].decode("ascii", "replace").strip()
        return f"{vendor} {product}", firmware, d

    def mode_sense(self):
        return self.command(0x43, expect_data=True)

    def test_unit_ready(self):
        self.command(0x42)

    def reserve(self):
        self.command(0x40)

    def release(self):
        self.command(0x4A)

    def initialize(self, abort=False):
        self.command(0x4C, bytes([0x80 if abort else 0x00, 0, 0, 0]))

    def scan(self, dpi, mode, x, y, w, h, adf=False, threshold=0xC3):
        """Scan an area given in pixels at `dpi`. Yields raw lines (top to bottom)."""
        composition, depth, bpp = MODES[mode]

        x600 = x * 600 // dpi
        y600 = y * 600 // dpi
        w600 = (w * 600 // dpi + 31) & ~31
        if x600 + w600 > 5100:
            over = x600 + w600 - 5100
            x600 = max(0, x600 - over)
            if x600 + w600 > 5100:
                w600 = 5100 - x600
        h600 = int(h * 600 / dpi + 0.5)

        px = ((w600 * dpi // 600) + 31) & ~31
        line_bytes = px // 8 if bpp is None else px * bpp
        self.log(f"window 600ths: x={x600} y={y600} w={w600} h={h600}; raw line {px}px = {line_bytes} bytes")

        self.reserve()
        try:
            self.test_unit_ready()
            self.initialize()
            self.command(0x44, bytes([0x03, 0x06, 0x00, 0x00, 0x02, 0x58, 0x00, 0x00]))
            page20 = bytearray(0x30)
            page20[0], page20[1], page20[2] = 0x20, 0x2E, 0x40 if adf else 0x00
            self.command(0x44, bytes(page20))

            win = bytearray(0x30)
            struct.pack_into(">HH", win, 0x02, dpi, dpi)
            # The Windows driver's scratch copy of the area lives inside the window buffer,
            # so the device receives it twice: at 0x08 and at 0x20.
            struct.pack_into(">IIII", win, 0x08, x600, y600, w600, h600)
            struct.pack_into(">IIII", win, 0x20, x600, y600, w600, h600)
            win[0x19] = threshold if depth == 1 else 0
            win[0x1A] = composition
            win[0x1B] = depth
            win[0x1D] = 0x36 if adf else 0x32
            self.command(0x45, bytes(win))
            self.command(0x48)

            lines_left = h
            lines_per_read = max(1, self.read_bytes // line_bytes)
            while lines_left > 0:
                n = min(lines_per_read, lines_left)
                data = self.command(0x49, struct.pack(">I", n * line_bytes), expect_data=True)
                if len(data) % line_bytes:
                    self.log(f"    Read returned {len(data)} bytes, not a multiple of {line_bytes}")
                got = len(data) // line_bytes
                if got == 0:
                    raise ScanError(f"Read returned {len(data)} bytes, less than one line")
                for i in range(got):
                    yield data[i * line_bytes:(i + 1) * line_bytes], px
                lines_left -= got
            self.initialize()
        except BaseException:
            try:
                self.initialize(abort=True)
            except Exception:
                pass
            raise
        finally:
            try:
                self.release()
            except Exception as e:
                self.log(f"release failed: {e}")


def write_pnm(path, mode, w, rows, rotate180=False):
    """Write lines as PBM/PGM/PPM, cropping padding to `w` pixels.

    Line art arrives MSB-first with 1 = black, which is already PBM's convention.
    The line count is only known at the end (ADF), so the body goes to a temp file first:
    PNM allows exactly one whitespace byte between the header and the pixel data.
    """
    tmp = path + ".body"
    count = 0
    with open(tmp, "wb") as body:
        for raw, px in rows:
            if mode == "lineart":
                body.write(raw[: (w + 7) // 8])
            elif mode == "gray":
                body.write(raw[:w])
            else:
                r, g, b = raw[:px], raw[px:2 * px], raw[2 * px:3 * px]
                out = bytearray(w * 3)
                out[0::3], out[1::3], out[2::3] = r[:w], g[:w], b[:w]
                body.write(out)
            count += 1
    magic = {"lineart": "P4", "gray": "P5", "color": "P6"}[mode]
    header = f"{magic}\n{w} {count}\n" + ("" if mode == "lineart" else "255\n")
    with open(path, "wb") as f, open(tmp, "rb") as body:
        f.write(header.encode())
        if rotate180 and count:
            # ADF pages arrive upside down: write lines bottom-up, pixels right-to-left.
            row_bytes = os.path.getsize(tmp) // count
            for i in range(count - 1, -1, -1):
                body.seek(i * row_bytes)
                row = body.read(row_bytes)
                if mode == "lineart":
                    nbits = row_bytes * 8
                    valid = f"{int.from_bytes(row, 'big'):0{nbits}b}"[:w]
                    f.write((int(valid[::-1], 2) << (nbits - w)).to_bytes(row_bytes, "big"))
                elif mode == "gray":
                    f.write(row[::-1])
                else:
                    px = bytearray(row)
                    rev = bytearray(len(px))
                    for c in range(3):
                        rev[c::3] = px[c::3][::-1]
                    f.write(rev)
        else:
            while chunk := body.read(1 << 20):
                f.write(chunk)
    os.remove(tmp)
    return count


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-v", "--verbose", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("probe")
    sp = sub.add_parser("scan")
    sp.add_argument("output")
    sp.add_argument("--dpi", type=int, default=150)
    sp.add_argument("--mode", choices=MODES, default="color")
    sp.add_argument("--area", default=None, help="x,y,w,h in pixels at --dpi (default: A4 flatbed)")
    sp.add_argument("--adf", action="store_true")
    sp.add_argument("--raw", action="store_true", help="write the raw device lines, no conversion")
    sp.add_argument("--rotate180", action="store_true", help="turn pages upside down (ADF orientation depends on how paper is loaded)")
    args = ap.parse_args()

    s = Scanner(verbose=args.verbose)
    try:
        if args.cmd == "probe":
            vendor, fw, raw = s.inquiry()
            print(f"Inquiry: vendor={vendor!r} firmware={fw!r}")
            print(f"  raw: {raw.hex(' ')}")
            ms = s.mode_sense()
            print(f"Mode Sense ({len(ms)} bytes): {ms.hex(' ')}")
            try:
                s.test_unit_ready()
                print("Test Unit Ready: OK")
            except CheckCondition as e:
                print(f"Test Unit Ready: {e}")
        else:
            if args.area:
                x, y, w, h = (int(v) for v in args.area.split(","))
            else:
                x, y = 0, 0
                w = 8490 * args.dpi // 1000
                h = 11685 * args.dpi // 1000
            if args.adf:
                # 64 KB Reads were reliable on the feeder; 256 KB failed (see docs/PROTOCOL.md).
                s.read_bytes = int(os.environ.get("SCAN_READ_BYTES", 0x10000))
            page = 1
            while True:
                out = args.output
                if args.adf:
                    stem, ext = os.path.splitext(args.output)
                    out = f"{stem}_p{page:02d}{ext}"
                rows = s.scan(args.dpi, args.mode, x, y, w, h, adf=args.adf)
                try:
                    if args.raw:
                        n = 0
                        with open(out, "wb") as f:
                            for raw, px in rows:
                                f.write(raw)
                                n += 1
                        print(f"raw line {px}px, {len(raw)} bytes")
                    else:
                        n = write_pnm(out, args.mode, w, rows, rotate180=args.rotate180)
                except CheckCondition as e:
                    if args.adf and e.sense[4:6] == b"\x02\x3a":
                        print(f"feeder empty after {page - 1} page(s)")
                        break
                    raise
                print(f"wrote {out}: {w}x{n}")
                if not args.adf:
                    break
                page += 1
    finally:
        s.close()


if __name__ == "__main__":
    main()
