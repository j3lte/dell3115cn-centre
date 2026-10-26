"""Scan jobs: run one scan request, write pages to a spool directory, report events."""

import contextlib
import dataclasses
import logging
import os
import queue
import shutil
import threading
import time
import uuid
from typing import Callable, ContextManager, Literal

from .pnm import write_pnm
from .protocol import (Busy, Cancelled, FeederEmpty, PaperJam, ScanParams, Scanner, SpoolError,
                       compute_geometry, scan_page)

log = logging.getLogger(__name__)

READ_BYTES = {"flatbed": 0x40000, "adf": 0x10000}


@dataclasses.dataclass
class PageInfo:
    n: int
    width: int
    height: int
    mode: str
    path: str
    bytes: int
    depth: int = 8


@dataclasses.dataclass
class JobResult:
    reason: Literal["complete", "feeder_empty", "jam", "cancelled", "error"]
    message: str
    pages: int


class Job:
    def __init__(self, job_id: str, params: ScanParams, created: float):
        self.id = job_id
        self.params = params
        self.pages: list[PageInfo] = []
        self.result: JobResult | None = None
        self.created = created
        self.finished: float | None = None
        self.done = threading.Event()
        self.deleted = False
        self._cancel = threading.Event()
        self._lock = threading.Lock()
        self._events: list[tuple[str, object]] = []
        self._subscribers: list[queue.Queue] = []

    def cancel(self) -> None:
        self._cancel.set()

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue()
        with self._lock:
            for e in self._events:
                q.put(e)
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            if q in self._subscribers:
                self._subscribers.remove(q)

    def _emit(self, event: str, data: object) -> None:
        with self._lock:
            self._events.append((event, data))
            for q in self._subscribers:
                q.put((event, data))


class JobRunner:
    def __init__(self, acquire: Callable[[], ContextManager[Scanner]], spool_dir: str,
                 ttl_s: float = 3600, clock: Callable[[], float] = time.time,
                 on_change: Callable[[], None] | None = None):
        self.acquire = acquire
        self.spool_dir = spool_dir
        self.ttl_s = ttl_s
        self.clock = clock
        self.on_change = on_change or (lambda: None)
        self.jobs: dict[str, Job] = {}
        self.active: Job | None = None
        self._lock = threading.Lock()

    @property
    def busy(self) -> bool:
        return self.active is not None

    def start(self, p: ScanParams) -> Job:
        p.validate()
        with self._lock:
            if self.active is not None:
                raise Busy("Scanner is busy")
            job = Job(uuid.uuid4().hex[:12], p, self.clock())
            os.makedirs(os.path.join(self.spool_dir, job.id), exist_ok=True)  # fails before anything is registered
            self.jobs[job.id] = job
            self.active = job
        threading.Thread(target=self._run, args=(job,), name=f"job-{job.id}", daemon=True).start()
        self.on_change()
        return job

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    def delete(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if job is None:
            return False
        job.cancel()
        with self._lock:
            self.jobs.pop(job_id, None)
            job.deleted = True
            running = job is self.active
        if not running:
            shutil.rmtree(os.path.join(self.spool_dir, job_id), ignore_errors=True)
        return True  # a running job removes its files when it ends

    def purge_spool(self) -> int:
        """Remove spool entries no job owns (left over from a previous run)."""
        removed = 0
        for name in os.listdir(self.spool_dir):
            if name not in self.jobs:
                path = os.path.join(self.spool_dir, name)
                if os.path.isdir(path):
                    shutil.rmtree(path, ignore_errors=True)
                else:
                    os.remove(path)
                removed += 1
        return removed

    def cleanup(self) -> int:
        now = self.clock()
        old = [j.id for j in list(self.jobs.values())
               if j.finished is not None and now - j.finished > self.ttl_s]
        for job_id in old:
            self.jobs.pop(job_id, None)
            shutil.rmtree(os.path.join(self.spool_dir, job_id), ignore_errors=True)
        return len(old)

    def _run(self, job: Job) -> None:
        p = job.params
        try:
            result = self._scan_pages(job)
        except Exception as e:  # noqa: BLE001 — every failure must end the job
            log.exception("job %s failed", job.id)
            result = JobResult("error", _error_message(e), len(job.pages))
        job.result = result
        job.finished = self.clock()
        with self._lock:
            self.active = None  # before `done`: a client may start the next scan as soon as it sees it
        job._emit("done", result)
        if job.deleted:
            shutil.rmtree(os.path.join(self.spool_dir, job.id), ignore_errors=True)
        job.done.set()
        self.on_change()
        log.info("job %s %s: %s (%d pages, %s %s %d dpi %d bit)", job.id, result.reason, result.message,
                 result.pages, p.source, p.mode, p.dpi, p.depth)

    def _scan_pages(self, job: Job) -> JobResult:
        p = job.params
        g = compute_geometry(p)
        with self.acquire() as s:
            while True:
                if job.cancelled:
                    return JobResult("cancelled", "Scan cancelled", len(job.pages))
                n = len(job.pages) + 1
                path = os.path.join(self.spool_dir, job.id, f"page-{n:03d}.pnm")
                try:
                    # closing(): the generator's abort + Release must run while we still hold the device
                    with contextlib.closing(scan_page(s, p, READ_BYTES[p.source], lambda: job.cancelled)) as rows:
                        height = write_pnm(path, p.mode, g.width, g.px, rows, p.depth, g.lines)
                except FeederEmpty:
                    if job.pages:
                        return JobResult("complete", "", len(job.pages))
                    return JobResult("feeder_empty", "No paper in the feeder", 0)
                except PaperJam:
                    where = f"after page {len(job.pages)}" if job.pages else "before the first page"
                    return JobResult("jam", f"Paper jam {where} — open and close the ADF cover", len(job.pages))
                except Cancelled:
                    return JobResult("cancelled", "Scan cancelled", len(job.pages))
                info = PageInfo(n, g.width, height, p.mode, path, os.path.getsize(path),
                                1 if p.mode == "lineart" else p.depth)
                job.pages.append(info)
                job._emit("page", info)
                if p.source == "flatbed":
                    return JobResult("complete", "", len(job.pages))


def _error_message(e: Exception) -> str:
    if isinstance(e, SpoolError):
        return str(e)
    if isinstance(e, TimeoutError):
        return "scanner timed out (no data from the scanner)"
    if isinstance(e, OSError) or type(e).__module__.startswith("usb"):
        return "printer disconnected"
    return str(e) or type(e).__name__
