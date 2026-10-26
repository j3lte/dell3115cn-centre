"""USB transport and the device manager (printer power on/off, exclusive access)."""

import contextlib
import logging
import threading
from typing import Callable, Iterator

from .protocol import CheckCondition, PaperJam, PrinterOff, ScanError, Scanner, Transport

log = logging.getLogger(__name__)

VID, PID = 0x413C, 0x5607
EP_OUT, EP_IN = 0x01, 0x82
TIMEOUT_MS = 120000  # lamp warm-up (~25 s) plus the first 256 KB Read must fit
DRAIN_TIMEOUT_MS = 200
EP_INT = 0x85
INT_TIMEOUT_MS = 300  # EP 0x85 is polled every 128 ms (bInterval 11, high speed)

# Panel Scan button (docs/PROTOCOL.md, "Button events"): an 8-byte press event naming the
# destination, then a 4-byte event naming the file format chosen on the panel.
TARGETS = {0x04: "application"}
FORMATS = {0x01: "jpeg", 0x03: "tiff", 0x04: "pdf"}


def parse_button_events(raws: list[bytes]) -> list[dict]:
    """Turn raw interrupt transfers into button events: press (00 30 .. TT) followed by format (01 00 00 FF)."""
    events, target = [], None
    for raw in raws:
        if len(raw) == 8 and raw[0] == 0x00 and raw[1] == 0x30:
            target = TARGETS.get(raw[7], f"target-{raw[7]:02x}")
        elif len(raw) == 4 and raw[0] == 0x01 and target is not None:
            events.append({"button": 1, "target": target, "format": FORMATS.get(raw[3], f"format-{raw[3]:02x}")})
            target = None
    return events


class UsbTransport:
    """Bulk transport on USB interface 0. Interface 1 (printing) is never touched."""

    def __init__(self, dev):
        self.dev = dev

    @classmethod
    def open(cls) -> "UsbTransport | None":
        import usb.core  # imported lazily so simulator mode runs without pyusb
        import usb.util

        dev = usb.core.find(idVendor=VID, idProduct=PID)
        if dev is None:
            return None
        try:
            if dev.is_kernel_driver_active(0):
                dev.detach_kernel_driver(0)
            usb.util.claim_interface(dev, 0)
        except BaseException:
            try:
                usb.util.dispose_resources(dev)  # don't leak the handle; the poll loop retries
            except Exception:  # noqa: BLE001 — keep the original error
                pass
            raise
        return cls(dev)

    def write(self, data: bytes) -> None:
        self.dev.write(EP_OUT, data, TIMEOUT_MS)

    def read(self, size: int) -> bytes:
        import usb.core

        try:
            return bytes(self.dev.read(EP_IN, size, TIMEOUT_MS))
        except usb.core.USBTimeoutError as e:
            raise TimeoutError(str(e)) from e

    def read_interrupt(self, size: int, timeout_ms: int) -> bytes:
        import usb.core

        try:
            return bytes(self.dev.read(EP_INT, size, timeout_ms))
        except usb.core.USBTimeoutError as e:
            raise TimeoutError(str(e)) from e

    def drain(self) -> int:
        """Discard stale IN data (e.g. a Read answered after a time-out). Returns bytes dropped."""
        import usb.core

        dropped = 0
        for _ in range(64):
            try:
                dropped += len(self.dev.read(EP_IN, 0x10000, DRAIN_TIMEOUT_MS))
            except usb.core.USBTimeoutError:
                break
        return dropped

    def close(self) -> None:
        import usb.util

        for fn in (lambda: usb.util.release_interface(self.dev, 0), lambda: usb.util.dispose_resources(self.dev)):
            try:
                fn()
            except Exception:  # noqa: BLE001 — device may already be gone
                pass


class DeviceManager:
    """Owns the transport. Finds the printer when it is switched on, drops it when it disappears.

    state: "off" (no device), "idle", "scanning" (acquired), "jammed".
    pyusb's USBError is an OSError, so OSError covers unplug/power-off during I/O.
    """

    def __init__(self, open_transport: Callable[[], Transport | None],
                 on_change: Callable[[], None] = lambda: None, poll_s: float = 2.0,
                 on_button: Callable[[dict], None] = lambda event: None):
        self.open_transport = open_transport
        self.on_change = on_change
        self.on_button = on_button
        self._int_pending: list[bytes] = []
        self.poll_s = poll_s
        self.state = "off"
        self.paper_in_feeder = False
        self._transport: Transport | None = None
        self._scanner: Scanner | None = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._poll_loop, name="device-poll", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)

    def _set(self, state: str, paper: bool | None = None) -> None:
        changed = state != self.state or (paper is not None and paper != self.paper_in_feeder)
        self.state = state
        if paper is not None:
            self.paper_in_feeder = paper
        if changed:
            log.info("printer %s (paper in feeder: %s)", state, self.paper_in_feeder)
            self.on_change()

    def _flags_seen(self, flags: int) -> None:
        """Track the feeder while scanning from the status blocks the scan gets anyway (byte 3, 0x40).

        The scan thread calls this with the lock held; outside a scan, _refresh sets the flag.
        """
        if self.state != "scanning":
            return
        try:
            self._set("scanning", bool(flags & 0x40))
        except Exception:  # noqa: BLE001 — a status listener must never break the scan
            log.exception("status update failed")

    def _drop(self) -> None:
        t, self._transport, self._scanner = self._transport, None, None
        close = getattr(t, "close", None)
        if close:
            close()
        self._set("off", False)

    def _resync(self) -> None:
        """Bring the device back to a known state: drop stale IN data, abort any scan, release.

        Used after opening the device and after protocol desync (bad status block, time-out).
        Caller holds the lock. Errors are swallowed; a dead device shows up in the next refresh.
        """
        sc = self._scanner
        if sc is None:
            return
        sc.rx.clear()
        drain = getattr(self._transport, "drain", None)
        try:
            if drain:
                dropped = drain()
                if dropped:
                    log.warning("discarded %d stale bytes from the scanner", dropped)
            sc.initialize(abort=True)
        except (ScanError, OSError):
            pass
        try:
            sc.release()
        except (ScanError, OSError):
            pass
        sc.rx.clear()

    def _refresh(self, retry: bool = True) -> None:
        """Test Unit Ready to learn jam/paper state. Caller holds the lock. Never raises."""
        try:
            self._scanner.test_unit_ready()
            self._set("idle", self._scanner.paper_in_feeder)
        except PaperJam:
            self._set("jammed", False)
        except CheckCondition:
            self._set("idle", self._scanner.paper_in_feeder)
        except OSError as e:  # includes TimeoutError: an unresponsive device is treated as gone
            log.warning("printer lost: %s", e)
            self._drop()
        except ScanError as e:  # protocol desync (stale bytes, reservation left behind)
            log.warning("scanner out of sync (%s), resynchronising", e)
            self._resync()
            if retry:
                self._refresh(retry=False)
            else:
                self._drop()

    def _read_buttons(self) -> None:
        """Drain the interrupt endpoint (the device holds events until polled). Caller holds the lock."""
        read = getattr(self._transport, "read_interrupt", None)
        if read is None:
            return
        while True:
            try:
                self._int_pending.append(read(8, INT_TIMEOUT_MS))
            except TimeoutError:
                break
            except OSError as e:
                log.warning("printer lost: %s", e)
                self._drop()
                return
        for event in parse_button_events(self._int_pending):
            log.info("panel button: %s", event)
            self.on_button(event)
        # keep an unfinished press (format event not yet read) for the next poll
        if self._int_pending and len(self._int_pending[-1]) == 8:
            self._int_pending = self._int_pending[-1:]
        else:
            self._int_pending = []

    def _poll_once(self) -> None:
        if self._transport is None:
            try:
                t = self.open_transport()
            except Exception as e:  # noqa: BLE001 — permission/busy: retry next poll
                log.warning("cannot open printer: %s", e)
                t = None
            if t is not None:
                self._transport, self._scanner = t, Scanner(t)
                self._scanner.on_flags = self._flags_seen
                self._resync()  # a previous run may have left a reservation or stale data
        if self._scanner is not None:
            self._read_buttons()
            if self._scanner is not None:
                self._refresh()
        else:
            self._set("off", False)

    def _poll_loop(self) -> None:
        while not self._stop.is_set():
            if self._lock.acquire(blocking=False):  # skip while a scan holds the device
                try:
                    self._poll_once()
                except Exception:  # noqa: BLE001 — the poll thread must never die
                    log.exception("device poll failed")
                finally:
                    self._lock.release()
            self._stop.wait(self.poll_s)

    @contextlib.contextmanager
    def acquire(self) -> Iterator[Scanner]:
        with self._lock:
            if self._scanner is None:
                raise PrinterOff("Printer is off or not connected")
            self._set("scanning")
            try:
                yield self._scanner
            except TimeoutError:
                self._resync()  # late data may still arrive; the device itself is probably fine
                raise
            except OSError:
                self._drop()
                raise
            finally:
                if self._scanner is not None:
                    try:
                        self._refresh()
                    except Exception:  # noqa: BLE001 — never mask the scan's own exception
                        log.exception("refresh after scan failed")
