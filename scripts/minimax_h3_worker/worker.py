#!/usr/bin/env python3
"""Bearer-authenticated durable worker for MiniMax H3 and CPU video composition.

PostgreSQL in V5 is the queue authority.  This service accepts at most one
fenced attempt per resource class and keeps only an execution mirror so a
master/tunnel reconnect never duplicates GPU work.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import mimetypes
import os
import re
import shutil
import signal
import sqlite3
import subprocess
import threading
import time
import urllib.request
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


IDENT = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
ATTEMPT_PATH = re.compile(r"^/v1/attempts/([^/]+)/([^/]+)(?:/(.*))?$")
TERMINAL = {"completed", "failed", "canceled"}


def gpu_release_limits(value):
    raw = value if value is not None else "2,2"
    parts = raw.split(",")
    if len(parts) != 2 or any(not re.fullmatch(r"\d{1,3}", part) for part in parts):
        raise SystemExit("H3_WORKER_GPU_RELEASE_MAX_PERCENT must be two comma-separated integers")
    limits = tuple(int(part) for part in parts)
    if any(limit > 100 for limit in limits):
        raise SystemExit("H3_WORKER_GPU_RELEASE_MAX_PERCENT values must be between 0 and 100")
    return limits


def now_ms():
    return int(time.time() * 1000)


def sha256_file(path: Path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def pid_alive(pid):
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError):
        return False


def pid_start_ticks(pid):
    try:
        return int(Path(f"/proc/{int(pid)}/stat").read_text().split()[21])
    except (OSError, ValueError, IndexError):
        return None


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.lock:
            self.db.executescript("""
                PRAGMA journal_mode=WAL;
                PRAGMA secure_delete=ON;
                CREATE TABLE IF NOT EXISTS attempts (
                    job_id TEXT NOT NULL,
                    attempt_id TEXT NOT NULL,
                    fence_version INTEGER NOT NULL,
                    origin_release TEXT,
                    resource_class TEXT NOT NULL,
                    request_digest TEXT,
                    request_json TEXT,
                    status TEXT NOT NULL,
                    phase TEXT NOT NULL,
                    current_step INTEGER,
                    total_steps INTEGER,
                    pid INTEGER,
                    pid_start_ticks INTEGER,
                    result_path TEXT,
                    result_sha256 TEXT,
                    result_size INTEGER,
                    error_code TEXT,
                    error_message TEXT,
                    recovery_disposition TEXT NOT NULL DEFAULT 'unknown',
                    cleanup_proven INTEGER NOT NULL DEFAULT 0,
                    cancel_requested_at INTEGER,
                    acked_at INTEGER,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (job_id, attempt_id)
                );
                CREATE TABLE IF NOT EXISTS inputs (
                    job_id TEXT NOT NULL,
                    attempt_id TEXT NOT NULL,
                    ordinal INTEGER NOT NULL,
                    kind TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    sha256 TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    mime TEXT NOT NULL,
                    path TEXT NOT NULL,
                    PRIMARY KEY (job_id, attempt_id, ordinal),
                    FOREIGN KEY (job_id, attempt_id) REFERENCES attempts(job_id, attempt_id)
                );
            """)
            columns = {row[1] for row in self.db.execute("PRAGMA table_info(attempts)")}
            if "pid_start_ticks" not in columns:
                self.db.execute("ALTER TABLE attempts ADD COLUMN pid_start_ticks INTEGER")
            if "recovery_disposition" not in columns:
                self.db.execute("ALTER TABLE attempts ADD COLUMN recovery_disposition TEXT NOT NULL DEFAULT 'unknown'")
            if "cleanup_proven" not in columns:
                self.db.execute("ALTER TABLE attempts ADD COLUMN cleanup_proven INTEGER NOT NULL DEFAULT 0")
            if "origin_release" not in columns:
                self.db.execute("ALTER TABLE attempts ADD COLUMN origin_release TEXT")
            self.db.commit()

    def ack_scrub(self, job_id, attempt_id):
        with self.lock:
            self.db.execute(
                "DELETE FROM inputs WHERE job_id=? AND attempt_id=?", (job_id, attempt_id)
            )
            self.db.execute(
                """UPDATE attempts SET request_json=NULL,result_path=NULL,pid=NULL,
                   pid_start_ticks=NULL,error_message=NULL,acked_at=?,updated_at=?
                   WHERE job_id=? AND attempt_id=?""",
                (now_ms(), now_ms(), job_id, attempt_id),
            )
            self.db.commit()
            self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()

    def row(self, job_id, attempt_id):
        with self.lock:
            return self.db.execute(
                "SELECT * FROM attempts WHERE job_id=? AND attempt_id=?", (job_id, attempt_id)
            ).fetchone()

    def inputs(self, job_id, attempt_id):
        with self.lock:
            return self.db.execute(
                "SELECT * FROM inputs WHERE job_id=? AND attempt_id=? ORDER BY ordinal", (job_id, attempt_id)
            ).fetchall()

    def ensure_staging(
        self, job_id, attempt_id, fence, resource_class="gpu-h3", origin_release=None
    ):
        ts = now_ms()
        release = origin_release or "unknown"
        with self.lock:
            row = self.row(job_id, attempt_id)
            if row is not None:
                if row["fence_version"] != fence:
                    raise Conflict("stale_fence")
                if origin_release is not None and row["origin_release"] != origin_release:
                    raise Conflict("attempt_release_conflict")
                if row["status"] not in {"staging", "queued"}:
                    raise Conflict("attempt_not_staging")
                return row
            self.db.execute(
                """INSERT INTO attempts
                   (job_id,attempt_id,fence_version,origin_release,resource_class,status,phase,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (job_id, attempt_id, fence, release, resource_class, "staging", "transferring_inputs", ts, ts),
            )
            self.db.commit()
            return self.row(job_id, attempt_id)

    def ensure_canceled_tombstone(
        self, job_id, attempt_id, fence, resource_class, origin_release
    ):
        ts = now_ms()
        with self.lock:
            row = self.row(job_id, attempt_id)
            if row is not None:
                return row, False
            self.db.execute(
                """INSERT INTO attempts
                   (job_id,attempt_id,fence_version,origin_release,resource_class,status,phase,
                    cancel_requested_at,created_at,updated_at)
                   VALUES (?,?,?,?,?,'canceled','canceled',?,?,?)""",
                (
                    job_id,
                    attempt_id,
                    fence,
                    origin_release,
                    resource_class,
                    ts,
                    ts,
                    ts,
                ),
            )
            self.db.commit()
            return self.row(job_id, attempt_id), True

    def put_input(self, job_id, attempt_id, item):
        with self.lock:
            existing = self.db.execute(
                "SELECT * FROM inputs WHERE job_id=? AND attempt_id=? AND ordinal=?",
                (job_id, attempt_id, item["ordinal"]),
            ).fetchone()
            if existing is not None:
                if any(
                    existing[key] != item[key]
                    for key in ("sha256", "size", "mime", "kind", "filename")
                ):
                    raise Conflict("input_ordinal_conflict")
                return
            self.db.execute(
                """INSERT INTO inputs
                   (job_id,attempt_id,ordinal,kind,filename,sha256,size,mime,path)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (job_id, attempt_id, item["ordinal"], item["kind"], item["filename"],
                 item["sha256"], item["size"], item["mime"], item["path"]),
            )
            self.db.commit()

    def submit(
        self, job_id, attempt_id, fence, resource_class, digest, request,
        origin_release=None,
    ):
        ts = now_ms()
        encoded = json.dumps(request, sort_keys=True, separators=(",", ":"))
        with self.lock:
            row = self.row(job_id, attempt_id)
            if row is None:
                self.ensure_staging(
                    job_id, attempt_id, fence, resource_class, origin_release=origin_release
                )
                row = self.row(job_id, attempt_id)
            if row["fence_version"] != fence:
                raise Conflict("stale_fence")
            if origin_release is not None and row["origin_release"] != origin_release:
                raise Conflict("attempt_release_conflict")
            if row["status"] in TERMINAL and row["request_digest"] is None:
                raise Conflict("attempt_not_staging")
            if row["request_digest"] is not None:
                if row["request_digest"] != digest or row["resource_class"] != resource_class:
                    raise Conflict("attempt_contract_conflict")
                return row, False
            busy = self.db.execute(
                """SELECT 1 FROM attempts
                   WHERE resource_class=? AND status IN ('queued','running')
                     AND NOT (job_id=? AND attempt_id=?) LIMIT 1""",
                (resource_class, job_id, attempt_id),
            ).fetchone()
            if busy is not None:
                raise Conflict("resource_busy")
            self.db.execute(
                """UPDATE attempts SET resource_class=?,request_digest=?,request_json=?,
                   status='queued',phase='queued',updated_at=?
                   WHERE job_id=? AND attempt_id=? AND fence_version=?""",
                (resource_class, digest, encoded, ts, job_id, attempt_id, fence),
            )
            self.db.commit()
            return self.row(job_id, attempt_id), True

    def update(self, job_id, attempt_id, **fields):
        if not fields:
            return
        fields["updated_at"] = now_ms()
        sql = ",".join(f"{key}=?" for key in fields)
        with self.lock:
            self.db.execute(
                f"UPDATE attempts SET {sql} WHERE job_id=? AND attempt_id=?",
                (*fields.values(), job_id, attempt_id),
            )
            self.db.commit()

    def start_execution(self, job_id, attempt_id):
        with self.lock:
            cur = self.db.execute(
                """UPDATE attempts SET status='running',phase='preparing',updated_at=?
                   WHERE job_id=? AND attempt_id=? AND status='queued'
                     AND cancel_requested_at IS NULL""",
                (now_ms(), job_id, attempt_id),
            )
            self.db.commit()
            return self.row(job_id, attempt_id) if cur.rowcount == 1 else None

    def cas_terminal(self, job_id, attempt_id, fence, status, **fields):
        fields.update(status=status, phase=status, updated_at=now_ms())
        sql = ",".join(f"{key}=?" for key in fields)
        with self.lock:
            cur = self.db.execute(
                f"""UPDATE attempts SET {sql}
                    WHERE job_id=? AND attempt_id=? AND fence_version=?
                      AND status NOT IN ('completed','failed','canceled')""",
                (*fields.values(), job_id, attempt_id, fence),
            )
            self.db.commit()
            return cur.rowcount == 1

    def active_rows(self):
        with self.lock:
            return self.db.execute("SELECT * FROM attempts WHERE status IN ('queued','running')").fetchall()


class Conflict(Exception):
    pass


class GpuLeasePoisoned(Exception):
    pass


class Worker:
    def __init__(self):
        self.root = Path(os.environ.get("H3_WORKER_STATE", "/root/private_data/openclaude-h3-worker"))
        self.worktree = Path(os.environ.get("H3_WORKER_RELEASE", "/root/private_data/minimax-h3-v5-worker"))
        self.h3_worktree = Path(
            os.environ.get("H3_SP_WORKTREE", "/root/private_data/minimax-h3-v5-worker")
        )
        self.sp_state = Path(os.environ.get("H3_SP_STATE_ROOT", "/root/minimax-h3-sp-runtime"))
        self.python = Path(os.environ.get("H3_SP_PYTHON", "/root/minimax-h3-runtime/venv/bin/python"))
        self.token = os.environ.get("H3_WORKER_TOKEN", "")
        self.gpu_release_max_percent = gpu_release_limits(
            os.environ.get("H3_WORKER_GPU_RELEASE_MAX_PERCENT")
        )
        supervisor_pid = os.environ.get("H3_SESSION_SUPERVISOR_PID")
        self.session_supervisor_pid = int(supervisor_pid) if supervisor_pid else None
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "attempts").mkdir(exist_ok=True)
        self.release = self._release_id()
        self.store = Store(self.root / "worker.sqlite")
        self.process_lock = threading.RLock()
        self.upload_lock = threading.RLock()
        self.ffmpeg = shutil.which(os.environ.get("H3_WORKER_FFMPEG", "ffmpeg"))
        self.ffprobe = shutil.which(os.environ.get("H3_WORKER_FFPROBE", "ffprobe"))
        self.compose_capable = self._probe_compose()
        self._recover()

    def _release_id(self):
        try:
            return subprocess.check_output(
                ["git", "-C", str(self.worktree), "rev-parse", "HEAD"],
                text=True,
                timeout=5,
                stderr=subprocess.DEVNULL,
            ).strip()
        except Exception:
            try:
                return self.worktree.resolve().name
            except OSError:
                return "unknown"

    def touch_session_lease(self):
        pid = self.session_supervisor_pid
        if pid is None or pid <= 1 or os.getppid() != pid:
            return
        try:
            os.kill(pid, signal.SIGUSR1)
        except ProcessLookupError:
            pass

    def _probe_compose(self):
        if not self.ffmpeg or not self.ffprobe:
            return False
        try:
            encoders = subprocess.check_output([self.ffmpeg, "-hide_banner", "-encoders"], text=True, timeout=10)
            filters = subprocess.check_output([self.ffmpeg, "-hide_banner", "-filters"], text=True, timeout=10)
            return all(name in encoders for name in ("libx264", "aac")) and "loudnorm" in filters
        except Exception:
            return False

    def capabilities(self):
        return {
            "protocol": "openclaude-h3-worker.v1",
            "release": self.release,
            "resources": {"gpu-h3": True, "cpu-compose": self.compose_capable},
            "h3": {
                "durations_seconds": [5, 10, 15],
                "canvases": [
                    {"aspect": "16:9", "width": 608, "height": 352},
                    {"aspect": "9:16", "width": 352, "height": 608},
                    {"aspect": "1:1", "width": 480, "height": 480},
                ],
                "modes": ["t2va", "fl2va", "ref2va", "ref2va_first_last_frame"],
                "reference_images_max": 9,
                "combined_ref_last_frame": True,
            },
            "compose": {
                "modes": ["normalize", "copy"],
                "transitions": False,
                "subtitles": False,
                "music": False,
            },
        }

    def _attempt_dir(self, job_id, attempt_id):
        return self.root / "attempts" / job_id / attempt_id

    def put_input(self, job_id, attempt_id, fence, ordinal, headers, stream):
        self._validate_ids(job_id, attempt_id)
        sha = headers.get("X-Content-SHA256", "").lower()
        size = int(headers.get("X-Content-Size", "-1"))
        mime = headers.get("Content-Type", "application/octet-stream").split(";", 1)[0]
        kind = headers.get("X-Input-Kind", "input")
        filename = os.path.basename(headers.get("X-Input-Filename", f"input-{ordinal}"))
        if (
            not re.fullmatch(r"[0-9a-f]{64}", sha)
            or size < 0
            or not re.fullmatch(r"[A-Za-z0-9._-]{1,255}", filename)
        ):
            raise ValueError("invalid_input_manifest")
        self.store.ensure_staging(job_id, attempt_id, fence, origin_release=self.release)
        directory = self._attempt_dir(job_id, attempt_id) / "inputs"
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / f"{ordinal:03d}-{sha}-{filename}"
        offset_header = headers.get("X-Upload-Offset")
        if offset_header is not None:
            chunk_size = int(headers.get("Content-Length", "-1"))
            offset = int(offset_header)
            if offset < 0 or chunk_size < 0 or offset + chunk_size > size:
                raise ValueError("invalid_upload_range")
            return self._put_input_chunk(
                job_id,
                attempt_id,
                fence,
                ordinal,
                sha,
                size,
                mime,
                kind,
                filename,
                target,
                offset,
                chunk_size,
                stream,
            )
        temp = target.with_suffix(target.suffix + ".part")
        digest = hashlib.sha256()
        remaining = size
        with temp.open("wb") as handle:
            while remaining:
                chunk = stream.read1(min(64 * 1024, remaining))
                if not chunk:
                    raise ValueError("short_input_stream")
                self.touch_session_lease()
                digest.update(chunk)
                handle.write(chunk)
                remaining -= len(chunk)
        if digest.hexdigest() != sha:
            temp.unlink(missing_ok=True)
            raise ValueError("input_sha256_mismatch")
        os.replace(temp, target)
        self.store.put_input(job_id, attempt_id, {
            "ordinal": ordinal, "kind": kind, "filename": filename, "sha256": sha,
            "size": size, "mime": mime, "path": str(target),
        })

    @staticmethod
    def _input_matches(row, manifest):
        return all(row[key] == manifest[key] for key in ("sha256", "size", "mime", "kind", "filename"))

    @staticmethod
    def _chunk_ranges(upload_dir):
        ranges = []
        for path in upload_dir.glob("*.chunk"):
            match = re.fullmatch(r"(\d{20})-(\d{20})\.chunk", path.name)
            if match:
                ranges.append((int(match.group(1)), int(match.group(2)), path))
        ranges.sort()
        coverage = 0
        for offset, length, _path in ranges:
            if offset != coverage:
                raise Conflict("upload_range_state_invalid")
            coverage += length
        return ranges, coverage

    @staticmethod
    def _write_atomic(path, data):
        temp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        with temp.open("wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)

    def _put_input_chunk(
        self,
        job_id,
        attempt_id,
        fence,
        ordinal,
        sha,
        size,
        mime,
        kind,
        filename,
        target,
        offset,
        chunk_size,
        stream,
    ):
        directory = target.parent
        upload_dir = directory / f".upload-{ordinal:03d}"
        pending = directory / (
            f".upload-{ordinal:03d}-pending-{offset:020d}-{os.getpid()}-"
            f"{threading.get_ident()}-{time.time_ns()}"
        )
        remaining = chunk_size
        try:
            with pending.open("xb") as handle:
                while remaining:
                    chunk = stream.read1(min(64 * 1024, remaining))
                    if not chunk:
                        raise ValueError("short_input_stream")
                    self.touch_session_lease()
                    handle.write(chunk)
                    remaining -= len(chunk)
                handle.flush()
                os.fsync(handle.fileno())

            manifest = {
                "fence": fence,
                "sha256": sha,
                "size": size,
                "mime": mime,
                "kind": kind,
                "filename": filename,
            }
            encoded_manifest = json.dumps(
                manifest, sort_keys=True, separators=(",", ":")
            ).encode("utf-8")
            item = {
                "ordinal": ordinal,
                "kind": kind,
                "filename": filename,
                "sha256": sha,
                "size": size,
                "mime": mime,
                "path": str(target),
            }

            with self.upload_lock:
                self.store.ensure_staging(
                    job_id, attempt_id, fence, origin_release=self.release
                )
                existing = next(
                    (row for row in self.store.inputs(job_id, attempt_id) if row["ordinal"] == ordinal),
                    None,
                )
                if existing is not None:
                    if not self._input_matches(existing, manifest):
                        raise Conflict("input_ordinal_conflict")
                    shutil.rmtree(upload_dir, ignore_errors=True)
                    return

                upload_dir.mkdir(parents=True, exist_ok=True)
                manifest_path = upload_dir / "manifest.json"
                if manifest_path.exists():
                    if manifest_path.read_bytes() != encoded_manifest:
                        raise Conflict("upload_manifest_conflict")
                else:
                    self._write_atomic(manifest_path, encoded_manifest)

                if target.exists():
                    if target.stat().st_size != size or sha256_file(target) != sha:
                        raise Conflict("published_input_integrity_failed")
                    self.store.put_input(job_id, attempt_id, item)
                    shutil.rmtree(upload_dir, ignore_errors=True)
                    return

                ranges, coverage = self._chunk_ranges(upload_dir)
                canonical = upload_dir / f"{offset:020d}-{chunk_size:020d}.chunk"
                if canonical.exists():
                    if canonical.stat().st_size != chunk_size or sha256_file(canonical) != sha256_file(pending):
                        raise Conflict("upload_chunk_conflict")
                else:
                    if offset != coverage:
                        raise Conflict("upload_offset_conflict")
                    os.replace(pending, canonical)

                ranges, coverage = self._chunk_ranges(upload_dir)
                if coverage < size:
                    return
                if coverage != size:
                    raise Conflict("upload_range_state_invalid")

                final_temp = upload_dir / (
                    f".final-{os.getpid()}-{threading.get_ident()}-{time.time_ns()}.tmp"
                )
                digest = hashlib.sha256()
                with final_temp.open("xb") as output:
                    for _chunk_offset, _chunk_length, path in ranges:
                        with path.open("rb") as source:
                            for block in iter(lambda: source.read(1024 * 1024), b""):
                                digest.update(block)
                                output.write(block)
                    output.flush()
                    os.fsync(output.fileno())
                if digest.hexdigest() != sha:
                    final_temp.unlink(missing_ok=True)
                    shutil.rmtree(upload_dir)
                    raise ValueError("input_sha256_mismatch")
                os.replace(final_temp, target)
                self.store.put_input(job_id, attempt_id, item)
                shutil.rmtree(upload_dir, ignore_errors=True)
        finally:
            pending.unlink(missing_ok=True)

    def submit(self, job_id, attempt_id, body):
        self._validate_ids(job_id, attempt_id)
        fence = int(body["fence_version"])
        resource = body["resource_class"]
        if resource not in {"gpu-h3", "cpu-compose"}:
            raise ValueError("invalid_resource_class")
        if resource == "cpu-compose" and not self.compose_capable:
            raise Conflict("compose_capability_unavailable")
        request = body["request"]
        digest = hashlib.sha256(
            json.dumps(request, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        expected = body.get("request_digest")
        if expected is not None and not hmac.compare_digest(expected, digest):
            raise ValueError("request_digest_mismatch")
        row, start = self.store.submit(
            job_id, attempt_id, fence, resource, digest, request,
            origin_release=self.release,
        )
        if start:
            threading.Thread(target=self._execute, args=(job_id, attempt_id), daemon=True).start()
        return self.public_row(row)

    def cancel(self, job_id, attempt_id, fence, resource_class=None):
        if resource_class is not None and resource_class not in ("gpu-h3", "cpu-compose"):
            raise ValueError("invalid_resource_class")
        row = self.store.row(job_id, attempt_id)
        if row is None:
            if resource_class is None:
                raise ValueError("resource_class is required for an unknown attempt")
            row, _created = self.store.ensure_canceled_tombstone(
                job_id, attempt_id, fence, resource_class, self.release
            )
        if row["fence_version"] != fence:
            raise Conflict("stale_fence")
        if row["status"] in TERMINAL:
            return self.public_row(row)
        self.store.update(job_id, attempt_id, cancel_requested_at=now_ms())
        if self._process_matches(row):
            try:
                os.killpg(int(row["pid"]), signal.SIGTERM)
            except ProcessLookupError:
                pass
        elif row["status"] in {"staging", "queued"}:
            self.store.cas_terminal(job_id, attempt_id, fence, "canceled")
        return self.public_row(self.store.row(job_id, attempt_id))

    def ack(self, job_id, attempt_id, fence):
        with self.upload_lock:
            row = self.store.row(job_id, attempt_id)
            if row is None:
                raise FileNotFoundError
            if row["fence_version"] != fence:
                raise Conflict("stale_fence")
            if row["status"] not in TERMINAL:
                raise Conflict("attempt_not_terminal")
            directory = self._attempt_dir(job_id, attempt_id)
            if directory.exists():
                shutil.rmtree(directory)
            if directory.exists():
                raise OSError("attempt_directory_cleanup_failed")
            self.store.ack_scrub(job_id, attempt_id)

    def public_row(self, row):
        if row is None:
            raise FileNotFoundError
        result = {key: row[key] for key in (
            "job_id", "attempt_id", "fence_version", "origin_release", "resource_class", "status", "phase",
            "request_digest", "current_step", "total_steps", "result_sha256", "result_size", "error_code",
            "error_message", "created_at", "updated_at",
            "recovery_disposition", "cleanup_proven",
        )}
        result["result_ready"] = bool(row["result_path"] and Path(row["result_path"]).is_file())
        return result

    def _process_identity(self, row):
        pid = row["pid"]
        if not pid:
            return "dead"
        try:
            start_ticks = int(Path(f"/proc/{int(pid)}/stat").read_text().split()[21])
        except FileNotFoundError:
            return "dead"
        except (OSError, ValueError, IndexError):
            return "unknown"
        if not row["pid_start_ticks"]:
            return "unknown"
        if start_ticks != row["pid_start_ticks"]:
            # The PID was reused; the exact fenced process is definitively gone.
            return "dead"
        try:
            argv = Path(f"/proc/{int(pid)}/cmdline").read_bytes().split(b"\0")
        except FileNotFoundError:
            return "dead"
        except OSError:
            return "unknown"
        values = [value.decode("utf-8", "replace") for value in argv if value]
        attempt_dir = str(self._attempt_dir(row["job_id"], row["attempt_id"]))
        if row["resource_class"] == "gpu-h3":
            pairs = dict(zip(values, values[1:]))
            matches = (
                any(value.endswith("coordinator.py") for value in values)
                and pairs.get("--job-id") == row["job_id"]
                and pairs.get("--attempt-id") == row["attempt_id"]
                and any(value.startswith(attempt_dir + os.sep) for value in values)
            )
        else:
            matches = any(value.startswith(attempt_dir + os.sep) for value in values)
        return "alive" if matches else "unknown"

    def _process_matches(self, row):
        return self._process_identity(row) == "alive"

    def result_path(self, job_id, attempt_id, fence):
        row = self.store.row(job_id, attempt_id)
        if row is None:
            raise FileNotFoundError
        if row["fence_version"] != fence:
            raise Conflict("stale_fence")
        if row["status"] != "completed" or not row["result_path"]:
            raise Conflict("result_not_ready")
        path = Path(row["result_path"])
        if not path.is_file() or sha256_file(path) != row["result_sha256"]:
            raise Conflict("result_integrity_failed")
        return path, row

    def _execute(self, job_id, attempt_id):
        row = self.store.start_execution(job_id, attempt_id)
        if row is None:
            return
        try:
            if row["resource_class"] == "gpu-h3":
                path = self._execute_h3(row)
            else:
                path = self._execute_compose(row)
            current = self.store.row(job_id, attempt_id)
            if current["cancel_requested_at"]:
                self.store.cas_terminal(
                    job_id, attempt_id, row["fence_version"], "canceled",
                    pid=None, pid_start_ticks=None,
                )
                return
            digest = sha256_file(path)
            self.store.cas_terminal(
                job_id, attempt_id, row["fence_version"], "completed",
                pid=None, pid_start_ticks=None,
                result_path=str(path), result_sha256=digest, result_size=path.stat().st_size,
            )
        except BaseException as exc:
            if isinstance(exc, GpuLeasePoisoned):
                current = self.store.row(job_id, attempt_id)
                if current is not None and current["status"] == "running":
                    self._schedule_recovery_retry(dict(current))
                return
            current = self.store.row(job_id, attempt_id)
            if current and current["cancel_requested_at"]:
                self.store.cas_terminal(
                    job_id, attempt_id, row["fence_version"], "canceled",
                    pid=None, pid_start_ticks=None,
                )
            else:
                self.store.cas_terminal(
                    job_id, attempt_id, row["fence_version"], "failed",
                    pid=None, pid_start_ticks=None,
                    error_code="worker_execution_failed", error_message=str(exc)[:1000],
                )

    def _ensure_ranks(self):
        healthy = True
        for port in (8290, 8291):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/system_stats", timeout=2):
                    pass
            except Exception:
                healthy = False
        if healthy:
            return
        env = os.environ.copy()
        env.update(
            H3_SP_WORKTREE=str(self.h3_worktree),
            H3_SP_STATE_ROOT=str(self.sp_state),
            H3_SP_PYTHON=str(self.python),
        )
        subprocess.run([str(self.worktree / "scripts/minimax_h3_sp/start.sh")], env=env, check=True, timeout=300)

    def _stop_ranks(self):
        env = os.environ.copy()
        env.update(H3_SP_STATE_ROOT=str(self.sp_state))
        subprocess.run(
            [str(self.worktree / "scripts/minimax_h3_sp/stop.sh")],
            env=env,
            check=True,
            timeout=60,
        )
        smi = Path("/opt/hyhal/bin/hy-smi")
        if not smi.is_file():
            raise RuntimeError("hy-smi is unavailable; cannot prove the GPU lease was released")
        deadline = time.monotonic() + 90
        pattern = re.compile(r"HCU\[(\d+)\].*memory use \(%\):\s*(\d+)")
        usage = {}
        while time.monotonic() < deadline:
            output = subprocess.check_output(
                [str(smi), "--showmemuse"], text=True, timeout=15, stderr=subprocess.STDOUT
            )
            usage = {int(rank): int(percent) for rank, percent in pattern.findall(output)}
            if (
                usage.keys() >= {0, 1}
                and usage[0] <= self.gpu_release_max_percent[0]
                and usage[1] <= self.gpu_release_max_percent[1]
            ):
                return
            time.sleep(2)
        raise RuntimeError(
            "H3 ranks stopped but GPU memory did not return within release thresholds "
            f"(limits={self.gpu_release_max_percent}, observed={usage})"
        )

    def _execute_h3(self, row):
        request = json.loads(row["request_json"])
        if not isinstance(request.get("prompt"), dict):
            raise ValueError("h3 request requires a Comfy prompt")
        directory = self._attempt_dir(row["job_id"], row["attempt_id"])
        directory.mkdir(parents=True, exist_ok=True)
        inputs = self.store.inputs(row["job_id"], row["attempt_id"])
        manifest = []
        rank0_input = self.sp_state / "rank0" / "input"
        rank0_input.mkdir(parents=True, exist_ok=True)
        for item in inputs:
            target = rank0_input / item["filename"]
            temp = target.with_suffix(target.suffix + ".part")
            shutil.copyfile(item["path"], temp)
            if sha256_file(temp) != item["sha256"]:
                temp.unlink(missing_ok=True)
                raise ValueError("staged_input_sha256_mismatch")
            os.replace(temp, target)
            manifest.append({key: item[key] for key in ("ordinal", "kind", "filename", "sha256", "size", "mime")})
            if item["kind"] == "clip" and item["filename"] == "continuity-source.mp4":
                self._extract_continuity_frame(target, rank0_input / "continuity-last.png")
        prompt_path = directory / "prompt.json"
        manifest_path = directory / "inputs.json"
        coordinator_result = directory / "coordinator-result.json"
        prompt_path.write_text(json.dumps({"prompt": request["prompt"]}, ensure_ascii=False))
        manifest_path.write_text(json.dumps(manifest, sort_keys=True))
        try:
            self._ensure_ranks()
            self.store.update(row["job_id"], row["attempt_id"], phase="loading_models")
            cmd = [
                str(self.python), str(self.worktree / "scripts/minimax_h3_sp/coordinator.py"), str(prompt_path),
                "--result", str(coordinator_result), "--pid-file", str(self.sp_state / "torchrun.pid"),
                "--lock-file", str(self.sp_state / "coordinator.lock"), "--input-manifest", str(manifest_path),
                "--job-id", row["job_id"], "--attempt-id", row["attempt_id"], "--timeout", "2400",
            ]
            process = subprocess.Popen(cmd, start_new_session=True)
            self.store.update(
                row["job_id"], row["attempt_id"], pid=process.pid,
                pid_start_ticks=pid_start_ticks(process.pid), phase="sampling",
            )
            while process.poll() is None:
                current = self.store.row(row["job_id"], row["attempt_id"])
                if current["cancel_requested_at"]:
                    os.killpg(process.pid, signal.SIGTERM)
                for progress in (self.sp_state / "progress").glob("*.json"):
                    try:
                        value = json.loads(progress.read_text())
                    except Exception:
                        continue
                    if value.get("job_id") == row["job_id"] and value.get("attempt_id") == row["attempt_id"]:
                        self.store.update(
                            row["job_id"], row["attempt_id"], phase=value.get("phase", "sampling"),
                            current_step=value.get("current_step"), total_steps=value.get("total_steps"),
                        )
                time.sleep(1)
            if process.returncode != 0:
                raise RuntimeError(f"H3 coordinator exited {process.returncode}")
            return self._publish_h3_result(row, coordinator_result)
        finally:
            self.store.update(row["job_id"], row["attempt_id"], phase="releasing_gpus")
            try:
                self._stop_ranks()
            except Exception as exc:
                self.store.update(
                    row["job_id"], row["attempt_id"], phase="gpu_cleanup_failed",
                    error_code="gpu_cleanup_failed", error_message=str(exc)[:1000],
                )
                raise GpuLeasePoisoned(str(exc)) from exc

    @staticmethod
    def _extract_continuity_frame(source, target):
        """Decode the exact final video frame used to condition the next shot."""
        import av

        temporary = target.with_suffix(".part.png")
        last = None
        with av.open(str(source)) as container:
            for frame in container.decode(video=0):
                last = frame
        if last is None:
            raise ValueError("continuity_source_has_no_video_frame")
        last.to_image().save(temporary, format="PNG")
        os.replace(temporary, target)

    def _publish_h3_result(self, row, coordinator_result):
        result = json.loads(coordinator_result.read_text())
        images = []
        for output in result["rank0"].get("outputs", {}).values():
            images.extend(output.get("images", []))
        media = next((item for item in images if item.get("filename", "").lower().endswith(".mp4")), None)
        if media is None:
            raise RuntimeError("H3 result did not contain an MP4")
        source = self.sp_state / "rank0" / "output" / media.get("subfolder", "") / media["filename"]
        directory = self._attempt_dir(row["job_id"], row["attempt_id"])
        target = directory / "result.mp4"
        shutil.copyfile(source, target.with_suffix(".part"))
        os.replace(target.with_suffix(".part"), target)
        return target

    def _execute_compose(self, row):
        request = json.loads(row["request_json"])
        if set(request) - {"mode", "manifest"}:
            raise ValueError("unsupported_compose_option")
        mode = request.get("mode", "normalize")
        if mode not in {"normalize", "copy"}:
            raise ValueError("unsupported_compose_mode")
        inputs = self.store.inputs(row["job_id"], row["attempt_id"])
        if not inputs:
            raise ValueError("compose requires at least one clip")
        directory = self._attempt_dir(row["job_id"], row["attempt_id"])
        concat = directory / "concat.txt"
        concat.write_text("".join(f"file '{Path(item['path']).resolve()}'\n" for item in inputs))
        target = directory / "result.mp4"
        if mode == "copy" and self._streams_compatible([Path(item["path"]) for item in inputs]):
            cmd = [self.ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(concat), "-c", "copy", str(target)]
        else:
            cmd = [
                self.ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(concat),
                "-vf", "fps=24,format=yuv420p", "-af", "aresample=48000,loudnorm",
                "-c:v", "libx264", "-preset", "medium", "-crf", "18",
                "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", str(target),
            ]
        process = subprocess.Popen(cmd, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.store.update(
            row["job_id"], row["attempt_id"], pid=process.pid,
            pid_start_ticks=pid_start_ticks(process.pid), phase="rendering",
        )
        _, stderr = process.communicate()
        if process.returncode != 0:
            raise RuntimeError(stderr.decode("utf-8", "replace")[-2000:])
        subprocess.run([self.ffprobe, "-v", "error", "-show_format", "-show_streams", str(target)], check=True, timeout=30)
        return target

    def _streams_compatible(self, paths):
        signatures = []
        for path in paths:
            raw = subprocess.check_output([
                self.ffprobe, "-v", "error", "-show_entries",
                "stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,sample_rate,channels",
                "-of", "json", str(path),
            ], text=True, timeout=30)
            signatures.append(json.dumps(json.loads(raw).get("streams", []), sort_keys=True))
        return bool(signatures) and len(set(signatures)) == 1

    def _recover(self):
        for row in self.store.active_rows():
            if row["status"] == "queued":
                threading.Thread(
                    target=self._execute,
                    args=(row["job_id"], row["attempt_id"]),
                    daemon=True,
                ).start()
                continue
            threading.Thread(target=self._monitor_recovered, args=(dict(row),), daemon=True).start()

    def _schedule_recovery_retry(self, row):
        retry = threading.Timer(30, self._monitor_recovered, args=(dict(row),))
        retry.daemon = True
        retry.start()

    def _monitor_recovered(self, row):
        while True:
            identity = self._process_identity(row)
            if identity == "alive":
                time.sleep(1)
                continue
            if identity == "unknown":
                self.store.update(
                    row["job_id"], row["attempt_id"], phase="recovery_identity_unknown"
                )
                self._schedule_recovery_retry(
                    dict(self.store.row(row["job_id"], row["attempt_id"]))
                )
                return
            break
        current = self.store.row(row["job_id"], row["attempt_id"])
        if current is None or current["status"] != "running":
            return
        terminal = "canceled" if current["cancel_requested_at"] else "completed"
        fields = {}
        try:
            directory = self._attempt_dir(row["job_id"], row["attempt_id"])
            if terminal == "completed":
                if row["resource_class"] == "gpu-h3":
                    coordinator_result = directory / "coordinator-result.json"
                    if not coordinator_result.is_file():
                        raise RuntimeError("recovered H3 coordinator produced no durable result")
                    path = self._publish_h3_result(row, coordinator_result)
                else:
                    path = directory / "result.mp4"
                    if not path.is_file():
                        raise RuntimeError("recovered compose process produced no durable result")
                    subprocess.run(
                        [self.ffprobe, "-v", "error", "-show_format", "-show_streams", str(path)],
                        check=True,
                        timeout=30,
                    )
                fields = {
                    "result_path": str(path),
                    "result_sha256": sha256_file(path),
                    "result_size": path.stat().st_size,
                }
        except Exception as exc:
            terminal = "failed"
            fields = {"error_code": "worker_lost", "error_message": str(exc)[:1000]}

        if row["resource_class"] == "gpu-h3":
            self.store.update(row["job_id"], row["attempt_id"], phase="releasing_gpus")
            try:
                self._stop_ranks()
            except Exception as exc:
                self.store.update(
                    row["job_id"], row["attempt_id"], phase="gpu_cleanup_failed",
                    error_code="gpu_cleanup_failed", error_message=str(exc)[:1000],
                )
                self._schedule_recovery_retry(dict(self.store.row(row["job_id"], row["attempt_id"])))
                return

        if terminal == "failed" and fields.get("error_code") == "worker_lost" and row["resource_class"] == "gpu-h3":
            # This is the sole replay authorization. Reaching here proves the
            # fenced coordinator PID is gone and rank cleanup succeeded.
            fields.update(
                recovery_disposition="definitive_retry_safe",
                cleanup_proven=1,
            )

        self.store.cas_terminal(
            row["job_id"], row["attempt_id"], row["fence_version"], terminal,
            pid=None, pid_start_ticks=None, **fields,
        )

    @staticmethod
    def _validate_ids(job_id, attempt_id):
        if not IDENT.fullmatch(job_id) or not IDENT.fullmatch(attempt_id):
            raise ValueError("invalid_attempt_identity")


class Handler(BaseHTTPRequestHandler):
    server_version = "OpenClaudeH3Worker/1"

    @property
    def worker(self):
        return self.server.worker

    def _authorized(self):
        expected = self.worker.token
        supplied = self.headers.get("Authorization", "")
        return bool(expected) and hmac.compare_digest(supplied, f"Bearer {expected}")

    def _json(self, status, value):
        data = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 16 * 1024 * 1024:
            raise ValueError("invalid_json_body_size")
        return json.loads(self.rfile.read(length))

    def _route(self):
        match = ATTEMPT_PATH.match(urlparse(self.path).path)
        if not match:
            raise FileNotFoundError
        return match.group(1), match.group(2), match.group(3) or ""

    def _handle(self, method):
        if method == "GET" and self.path == "/":
            return self._json(200, {"ok": True})
        if not self._authorized():
            return self._json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
        self.worker.touch_session_lease()
        path = urlparse(self.path).path
        if method == "GET" and path == "/v1/health":
            return self._json(200, {"ok": True, "release": self.worker.release, "protocol": "openclaude-h3-worker.v1"})
        if method == "GET" and path == "/v1/capabilities":
            return self._json(200, self.worker.capabilities())
        job_id, attempt_id, action = self._route()
        fence = int(self.headers.get("X-Fence-Version", "0"))
        if method == "PUT" and action.startswith("inputs/"):
            ordinal = int(action.split("/", 1)[1])
            self.worker.put_input(job_id, attempt_id, fence, ordinal, self.headers, self.rfile)
            return self._json(201, {"ok": True})
        if method == "POST" and action == "submit":
            return self._json(202, self.worker.submit(job_id, attempt_id, self._body()))
        if method == "GET" and action in {"", "status"}:
            return self._json(200, self.worker.public_row(self.worker.store.row(job_id, attempt_id)))
        if method == "POST" and action == "cancel":
            body = self._body()
            return self._json(
                200,
                self.worker.cancel(job_id, attempt_id, fence, body.get("resource_class")),
            )
        if method == "POST" and action == "ack":
            self.worker.ack(job_id, attempt_id, fence)
            return self._json(200, {"ok": True})
        if method == "GET" and action == "result":
            path, row = self.worker.result_path(job_id, attempt_id, fence)
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(path.stat().st_size))
            self.send_header("X-Content-SHA256", row["result_sha256"])
            self.end_headers()
            with path.open("rb") as handle:
                while chunk := handle.read(64 * 1024):
                    self.worker.touch_session_lease()
                    self.wfile.write(chunk)
            return
        raise FileNotFoundError

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def _dispatch(self, method):
        try:
            self._handle(method)
        except FileNotFoundError:
            self._json(404, {"error": "not_found"})
        except Conflict as exc:
            self._json(409, {"error": str(exc)})
        except (ValueError, KeyError, json.JSONDecodeError) as exc:
            self._json(400, {"error": str(exc)})
        except Exception as exc:
            self._json(500, {"error": "internal_error", "detail": str(exc)[:500]})

    def log_message(self, fmt, *args):
        print(f"H3_WORKER {self.address_string()} {fmt % args}", flush=True)


def worker_bind_host():
    host = os.environ.get("H3_WORKER_HOST", "127.0.0.1")
    if host in {"127.0.0.1", "::1", "localhost"}:
        return host
    if host == "0.0.0.0" and os.environ.get("H3_WORKER_ALLOW_PUBLIC_BIND") == "1":
        return host
    raise SystemExit("H3 worker must be loopback-only unless public binding is explicitly enabled")


def main():
    worker = Worker()
    host = worker_bind_host()
    port = int(os.environ.get("H3_WORKER_PORT", "8390"))
    if not worker.token:
        raise SystemExit("H3_WORKER_TOKEN is required")
    server = ThreadingHTTPServer((host, port), Handler)
    server.worker = worker
    print(json.dumps({"event": "worker_ready", "host": host, "port": port, **worker.capabilities()}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
