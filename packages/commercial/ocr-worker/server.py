#!/usr/bin/env python3
"""Private HTTP API and durable multi-tenant FIFO for OCR jobs."""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from worker_common import ACTIVE, cleanup_expired, connect, init_db, owner_usage, public_status


class Api:
    def __init__(self, root: Path, cards: list[int], token: str, release: str):
        self.root = root
        self.jobs = root / "jobs"
        self.ready = root / "ready"
        self.db_path = root / "jobs.sqlite3"
        self.cards = cards
        self.token = token
        self.release = release
        self.retention_s = int(os.environ.get("OC_OCR_RESULT_RETENTION_SECONDS", str(7 * 86400)))
        self.disk_reserve = int(os.environ.get("OC_OCR_DISK_RESERVE_BYTES", str(20 * 1024**3)))
        self.owner_share_divisor = int(os.environ.get("OC_OCR_OWNER_DISK_SHARE_DIVISOR", "8"))
        self.owner_max_jobs = int(os.environ.get("OC_OCR_OWNER_MAX_ACTIVE_JOBS", str(max(2, 2 * len(cards)))))
        self.jobs.mkdir(parents=True, exist_ok=True)
        self.ready.mkdir(parents=True, exist_ok=True)
        init_db(self.db_path)

    def disk(self) -> tuple[int, int]:
        usage = shutil.disk_usage(self.root)
        budget = max(0, usage.total - self.disk_reserve) // max(1, self.owner_share_divisor)
        return usage.free, budget

    def engines_ready(self) -> bool:
        return all((self.ready / f"pp-{card}").exists() and (self.ready / f"vl-{card}").exists() for card in self.cards)


class Handler(BaseHTTPRequestHandler):
    server_version = "OpenClaudeOCR/1"

    @property
    def api(self) -> Api:
        return self.server.api  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: object) -> None:
        print(json.dumps({"event": "http", "message": fmt % args}, ensure_ascii=False), flush=True)

    def json(self, status: int, value: object) -> None:
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def authorized(self) -> bool:
        if self.headers.get("authorization") == f"Bearer {self.api.token}":
            return True
        self.json(401, {"error": "unauthorized"})
        return False

    def owner(self) -> str | None:
        value = self.headers.get("x-ocr-owner", "")
        if re.fullmatch(r"[A-Za-z0-9_-]{40,64}", value):
            return value
        self.json(400, {"error": "invalid owner"})
        return None

    def read_stream(self, target: Path, job_id: str, owner: str, owner_budget: int) -> int:
        transfer = self.headers.get("transfer-encoding", "").lower()
        remaining = int(self.headers["content-length"]) if self.headers.get("content-length") else None
        total = 0
        with target.open("wb") as output:
            while True:
                if "chunked" in transfer:
                    line = self.rfile.readline(128)
                    if not line:
                        raise ConnectionError("incomplete chunked upload")
                    size = int(line.split(b";", 1)[0], 16)
                    if size == 0:
                        self.rfile.readline()
                        break
                    chunk = self.rfile.read(size)
                    self.rfile.read(2)
                else:
                    if remaining is not None and remaining <= 0:
                        break
                    chunk = self.rfile.read(min(1024 * 1024, remaining or 1024 * 1024))
                    if not chunk:
                        break
                    if remaining is not None:
                        remaining -= len(chunk)
                output.write(chunk)
                total += len(chunk)
                free, _ = self.api.disk()
                db = connect(self.api.db_path)
                try:
                    db.execute("BEGIN IMMEDIATE")
                    _, used = owner_usage(db, owner)
                    if used + len(chunk) > owner_budget or free - len(chunk) < self.api.disk_reserve:
                        db.execute("ROLLBACK")
                        raise OSError("storage quota exceeded")
                    db.execute("UPDATE jobs SET source_bytes=?, updated_at=? WHERE id=?", (total, time.time(), job_id))
                    db.execute("COMMIT")
                finally:
                    db.close()
        if remaining not in (None, 0):
            raise ValueError("incomplete upload")
        return total

    def do_GET(self) -> None:
        if not self.authorized():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/ready":
            value = {
                "release": self.api.release,
                "protocol_major": 1,
                "ready": self.api.engines_ready(),
                "cards": self.api.cards,
                "capabilities": {
                    "modes": ["pp", "hybrid", "vl"],
                    "max_page_pixels": int(os.environ.get("OC_OCR_MAX_PAGE_PIXELS", "24000000")),
                    "max_page_dimension": int(os.environ.get("OC_OCR_MAX_PAGE_DIMENSION", "10000")),
                },
            }
            self.json(200 if value["ready"] else 503, value)
            return
        match = re.fullmatch(r"/v1/jobs/([A-Za-z0-9-]+)(/result)?", parsed.path)
        if not match:
            self.json(404, {"error": "not found"})
            return
        owner = self.owner()
        if owner is None:
            return
        cleanup_expired(self.api.db_path, self.api.jobs)
        db = connect(self.api.db_path)
        row = db.execute("SELECT * FROM jobs WHERE id=? AND owner=?", (match.group(1), owner)).fetchone()
        if row is None:
            db.close()
            self.json(404, {"error": "job not found"})
            return
        if not match.group(2):
            value = public_status(db, row)
            db.close()
            self.json(200, value)
            return
        if row["status"] != "completed":
            db.close()
            self.json(409, {"error": "result is not ready"})
            return
        fmt = parse_qs(parsed.query).get("format", ["markdown"])[0]
        stored_path = row["result_jsonl"] if fmt == "jsonl" else row["result_md"]
        db.close()
        if not stored_path:
            self.json(410, {"error": "result expired"})
            return
        path = Path(stored_path)
        if not path.exists():
            self.json(410, {"error": "result expired"})
            return
        self.send_response(200)
        self.send_header("content-type", "application/x-ndjson" if fmt == "jsonl" else "text/markdown; charset=utf-8")
        self.send_header("content-length", str(path.stat().st_size))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        with path.open("rb") as source:
            shutil.copyfileobj(source, self.wfile, 1024 * 1024)

    def do_POST(self) -> None:
        if not self.authorized():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/v1/jobs":
            self.submit()
            return
        match = re.fullmatch(r"/v1/jobs/([A-Za-z0-9-]+)/cancel", parsed.path)
        if match:
            self.cancel(match.group(1))
            return
        self.json(404, {"error": "not found"})

    def submit(self) -> None:
        owner = self.owner()
        if owner is None:
            return
        mode = self.headers.get("x-ocr-mode", "hybrid")
        try:
            fallback = float(self.headers.get("x-ocr-fallback", "0.10"))
        except ValueError:
            fallback = -1
        if mode not in {"pp", "hybrid", "vl"} or not 0 <= fallback <= 1:
            self.json(400, {"error": "invalid mode or fallback"})
            return
        cleanup_expired(self.api.db_path, self.api.jobs)
        free, owner_budget = self.api.disk()
        declared = int(self.headers.get("content-length", "0") or 0)
        db = connect(self.api.db_path)
        db.execute("BEGIN IMMEDIATE")
        active, used = owner_usage(db, owner)
        if active >= self.api.owner_max_jobs:
            db.execute("ROLLBACK")
            db.close()
            self.json(429, {"error": "owner active-job capacity reached", "details": {"active": active, "limit": self.api.owner_max_jobs}})
            return
        if declared and (used + declared > owner_budget or free - declared < self.api.disk_reserve):
            db.execute("ROLLBACK")
            db.close()
            self.json(507, {"error": "storage quota exceeded", "details": {"used_bytes": used, "budget_bytes": owner_budget, "free_bytes": free, "reserve_bytes": self.api.disk_reserve}})
            return
        job_id = str(uuid.uuid4())
        job_dir = self.api.jobs / job_id
        job_dir.mkdir(mode=0o700)
        source = job_dir / "source"
        now = time.time()
        db.execute(
            "INSERT INTO jobs(id,owner,filename,mode,fallback,status,phase,source_path,created_at,updated_at) VALUES(?,?,?,?,?,'uploading','uploading',?,?,?)",
            (job_id, owner, self.headers.get("x-ocr-filename", "document")[:240], mode, fallback, str(source), now, now),
        )
        db.execute("COMMIT")
        db.close()
        try:
            size = self.read_stream(source, job_id, owner, owner_budget)
            if size <= 0:
                raise ValueError("empty upload")
            db = connect(self.api.db_path)
            db.execute("UPDATE jobs SET status='queued',phase='queued',source_bytes=?,updated_at=? WHERE id=?", (size, time.time(), job_id))
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            value = public_status(db, row)
            db.close()
            self.json(202, value)
        except Exception as exc:
            shutil.rmtree(job_dir, ignore_errors=True)
            db = connect(self.api.db_path)
            db.execute("DELETE FROM jobs WHERE id=?", (job_id,))
            db.close()
            status = 507 if isinstance(exc, OSError) else 400
            self.json(status, {"error": str(exc), "details": {"budget_bytes": owner_budget, "reserve_bytes": self.api.disk_reserve}})

    def cancel(self, job_id: str) -> None:
        owner = self.owner()
        if owner is None:
            return
        db = connect(self.api.db_path)
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT * FROM jobs WHERE id=? AND owner=?", (job_id, owner)).fetchone()
        if row is None:
            db.execute("ROLLBACK")
            db.close()
            self.json(404, {"error": "job not found"})
            return
        now = time.time()
        if row["status"] in {"uploading", "queued"}:
            shutil.rmtree(self.api.jobs / job_id, ignore_errors=True)
            db.execute(
                "UPDATE jobs SET status='cancelled',phase='cancelled',source_path=NULL,source_bytes=0,result_bytes=0,completed_at=?,result_expires_at=?,updated_at=? WHERE id=?",
                (now, now + self.api.retention_s, now, job_id),
            )
        elif row["status"] == "running":
            db.execute("UPDATE jobs SET cancel_requested=1,phase='cancelling',updated_at=? WHERE id=?", (now, job_id))
        db.execute("COMMIT")
        row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        value = public_status(db, row)
        db.close()
        self.json(200, value)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--listen", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18960)
    parser.add_argument("--cards", required=True)
    args = parser.parse_args()
    cards = [int(value) for value in args.cards.split(",") if value.strip()]
    token = os.environ.get("OC_OCR_WORKER_TOKEN", "")
    release = os.environ.get("OC_OCR_WORKER_RELEASE", "")
    if not token or not release or not cards:
        raise SystemExit("OC_OCR_WORKER_TOKEN, OC_OCR_WORKER_RELEASE and --cards are required")
    api = Api(args.root, cards, token, release)
    server = ThreadingHTTPServer((args.listen, args.port), Handler)
    server.api = api  # type: ignore[attr-defined]
    print(json.dumps({"event": "server_started", "listen": args.listen, "port": args.port, "release": release, "cards": cards}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
