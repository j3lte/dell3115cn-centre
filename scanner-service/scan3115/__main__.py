"""Entry point: python -m scan3115

Environment:
  SCAN3115_PORT        HTTP port (default 8765)
  SCAN3115_BIND        bind address (default 0.0.0.0)
  SCAN3115_SPOOL       spool directory for page files (default /var/lib/scan3115)
  SCAN3115_SIM         1 = use the simulated scanner instead of USB
  SCAN3115_SIM_PAGES   pages in the simulated feeder (default 3, refilled after each batch)
  SCAN3115_SIM_JAM     simulate one jam at "page:line" (cleared after SCAN3115_SIM_JAM_CLEAR_S, default 5)
  SCAN3115_CORS_ORIGIN send Access-Control-Allow-Origin with this value (default: no CORS headers)
  SCAN3115_LOG         log level (default INFO)
"""

import logging
import os
import signal
import threading

from . import __version__
from .device import DeviceManager, UsbTransport
from .jobs import JobRunner
from .server import StatusHub, make_server
from .sim import sim_from_env

CLEANUP_S = 300
log = logging.getLogger("scan3115")


def shutdown(runner: JobRunner, dm: DeviceManager, timeout: float = 10.0) -> None:
    """Cancel a running scan and wait for it to release the scanner, then stop polling."""
    job = runner.active
    if job is not None:
        log.info("stopping: cancelling job %s", job.id)
        job.cancel()
        job.done.wait(timeout)
    dm.stop()


def _terminate(signum, frame):
    raise SystemExit(0)


def main() -> None:
    logging.basicConfig(level=os.environ.get("SCAN3115_LOG", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    port = int(os.environ.get("SCAN3115_PORT", "8765"))
    bind = os.environ.get("SCAN3115_BIND", "0.0.0.0")
    spool = os.environ.get("SCAN3115_SPOOL", "/var/lib/scan3115")
    os.makedirs(spool, exist_ok=True)

    if os.environ.get("SCAN3115_SIM") == "1":
        sim = sim_from_env(os.environ)
        open_transport = lambda: sim  # noqa: E731
        log.info("simulator mode (%d pages in feeder, jam at %s)", sim.adf_pages, sim.jam_at)
    else:
        open_transport = UsbTransport.open

    hub = StatusHub()
    runner: JobRunner | None = None

    def status() -> dict:
        busy = runner is not None and runner.busy
        return {"service": "scan3115", "version": __version__,
                "printer": "scanning" if busy and dm.state != "off" else dm.state,
                "paper_in_feeder": dm.paper_in_feeder,
                "job": runner.active.id if busy and runner.active else None}

    def publish() -> None:
        hub.publish("status", status())

    dm = DeviceManager(open_transport, on_change=publish,
                       on_button=lambda event: hub.publish("button", event))
    runner = JobRunner(dm.acquire, spool, on_change=publish)
    if n := runner.purge_spool():
        log.info("removed %d leftover spool entr%s from a previous run", n, "y" if n == 1 else "ies")
    dm.start()

    def cleanup_loop() -> None:
        while True:
            threading.Event().wait(CLEANUP_S)
            try:
                if n := runner.cleanup():
                    log.info("removed %d expired job(s) from the spool", n)
            except Exception:  # noqa: BLE001
                log.exception("spool cleanup failed")

    threading.Thread(target=cleanup_loop, name="cleanup", daemon=True).start()
    srv = make_server(runner, status, hub, bind, port, cors_origin=os.environ.get("SCAN3115_CORS_ORIGIN"))
    signal.signal(signal.SIGTERM, _terminate)  # systemd stop/restart: release the scanner first
    log.info("scan3115 %s listening on %s:%d, spool %s", __version__, bind, port, spool)
    try:
        srv.serve_forever()
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        srv.server_close()
        shutdown(runner, dm)


if __name__ == "__main__":
    main()
